import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { BudgetStatus, DirectoryStatus, Prisma } from '@prisma/client';

import { BusinessRuleException } from '../common';
import type { AccountingRepository, BudgetRow } from './accounting.repository';
import { BudgetService } from './budget.service';
import { BudgetsQueryDto } from './dto';

const BUDGET_ID = '11111111-1111-1111-1111-111111111111';
const TAX_ID = '22222222-2222-2222-2222-222222222222';
const VAT_ID = '33333333-3333-3333-3333-333333333333';
const OFFICE_ID = '44444444-4444-4444-4444-444444444444';
const ACCOUNT_ID = '55555555-5555-5555-5555-555555555555';
const EMPLOYEE_ID = '66666666-6666-6666-6666-666666666666';

type Category = { id: string; name: string; status: DirectoryStatus; parentId: string | null };

const category = (overrides: Partial<Category> = {}): Category => ({
  id: OFFICE_ID,
  name: 'Офис',
  status: DirectoryStatus.ACTIVE,
  parentId: null,
  ...overrides,
});

const budgetLine = (
  overrides: Partial<BudgetRow['lines'][number]> = {},
): BudgetRow['lines'][number] => ({
  id: 'line-1',
  allocated: new Prisma.Decimal('12000.00'),
  note: null,
  category: { id: OFFICE_ID, name: 'Офис', parent: null },
  ...overrides,
});

const row = (overrides: Partial<BudgetRow> = {}): BudgetRow => ({
  id: BUDGET_ID,
  name: 'Бюджет на I квартал 2026',
  description: null,
  periodFrom: new Date('2026-01-01T00:00:00.000Z'),
  periodTo: new Date('2026-03-01T00:00:00.000Z'),
  status: BudgetStatus.DRAFT,
  salaryAllocated: null,
  createdAt: new Date('2026-01-05T09:00:00.000Z'),
  createdBy: null,
  lines: [budgetLine()],
  ...overrides,
});

const query = (overrides: Partial<BudgetsQueryDto> = {}): BudgetsQueryDto =>
  Object.assign(new BudgetsQueryDto(), overrides);

describe('BudgetService', () => {
  let repository: jest.Mocked<
    Pick<
      AccountingRepository,
      | 'findManyBudgets'
      | 'findBudgetById'
      | 'findBudgetByName'
      | 'createBudget'
      | 'updateBudget'
      | 'deleteBudget'
      | 'findExpenseTotalsByCategory'
      | 'findChildIdsByParents'
      | 'findCategoriesByIds'
      | 'findEmployeeByAccount'
    >
  >;
  let service: BudgetService;

  beforeEach(() => {
    repository = {
      findManyBudgets: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findBudgetById: jest.fn().mockResolvedValue(row()),
      findBudgetByName: jest.fn().mockResolvedValue(null),
      createBudget: jest.fn().mockResolvedValue(row()),
      updateBudget: jest.fn().mockResolvedValue(row()),
      deleteBudget: jest.fn().mockResolvedValue(undefined),
      findExpenseTotalsByCategory: jest.fn().mockResolvedValue(new Map()),
      findChildIdsByParents: jest.fn().mockResolvedValue(new Map()),
      findCategoriesByIds: jest.fn().mockResolvedValue([category()]),
      findEmployeeByAccount: jest.fn().mockResolvedValue({ id: EMPLOYEE_ID }),
    };

    service = new BudgetService(repository as unknown as AccountingRepository);
  });

  describe('список', () => {
    it('отдаёт период месяцами, название статуса и число строк', async () => {
      const page = await service.findAll(query());

      expect(page.items[0]).toMatchObject({
        id: BUDGET_ID,
        periodFrom: '2026-01',
        periodTo: '2026-03',
        status: BudgetStatus.DRAFT,
        statusTitle: 'Черновик',
        linesCount: 1,
      });
    });

    it('считает `spent` по расходам периода бюджета', async () => {
      repository.findExpenseTotalsByCategory.mockResolvedValue(new Map([[OFFICE_ID, 450_000]]));

      const page = await service.findAll(query());

      expect(page.items[0].totals).toMatchObject({
        allocated: 12_000,
        spent: 4500,
        remaining: 7500,
      });
    });

    it('расходы спрашиваются за период плана, правая граница не включающая', async () => {
      await service.findAll(query());

      // Правая граница периода включающая, поэтому в запрос уходит первое число
      // апреля: считать последний день марта значило бы выводить самому,
      // сколько их в месяце.
      expect(repository.findExpenseTotalsByCategory).toHaveBeenCalledWith(
        new Date('2026-01-01T00:00:00.000Z'),
        new Date('2026-04-01T00:00:00.000Z'),
        [OFFICE_ID],
      );
    });

    it('бюджеты с одинаковым периодом читают расходы одним запросом', async () => {
      repository.findManyBudgets.mockResolvedValue({
        rows: [row({ id: 'a' }), row({ id: 'b' })],
        total: 2,
      });

      await service.findAll(query());

      expect(repository.findExpenseTotalsByCategory).toHaveBeenCalledTimes(1);
    });

    it('разные периоды читают расходы своими запросами', async () => {
      repository.findManyBudgets.mockResolvedValue({
        rows: [
          row({ id: 'a' }),
          row({
            id: 'b',
            periodFrom: new Date('2026-04-01T00:00:00.000Z'),
            periodTo: new Date('2026-06-01T00:00:00.000Z'),
          }),
        ],
        total: 2,
      });

      await service.findAll(query());

      expect(repository.findExpenseTotalsByCategory).toHaveBeenCalledTimes(2);
    });

    it('в запрос расходов идут и подстатьи запланированного раздела', async () => {
      repository.findManyBudgets.mockResolvedValue({
        rows: [
          row({
            lines: [budgetLine({ category: { id: TAX_ID, name: 'Налоги', parent: null } })],
          }),
        ],
        total: 1,
      });
      repository.findChildIdsByParents.mockResolvedValue(new Map([[TAX_ID, [VAT_ID]]]));

      await service.findAll(query());

      expect(repository.findExpenseTotalsByCategory).toHaveBeenCalledWith(
        expect.any(Date),
        expect.any(Date),
        [TAX_ID, VAT_ID],
      );
    });

    it('передаёт окно страницы, фильтры и период в выборку', async () => {
      await service.findAll(
        query({
          page: 2,
          limit: 5,
          status: BudgetStatus.ACTIVE,
          categoryId: OFFICE_ID,
          from: '2026-02',
          to: '2026-05',
          search: 'квартал',
        }),
      );

      expect(repository.findManyBudgets).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 5,
          take: 5,
          status: BudgetStatus.ACTIVE,
          categoryId: OFFICE_ID,
          from: new Date('2026-02-01T00:00:00.000Z'),
          to: new Date('2026-05-01T00:00:00.000Z'),
          search: 'квартал',
        }),
      );
    });

    it('400 на несуществующий месяц в фильтре — до запроса', async () => {
      await expect(service.findAll(query({ from: '2026-13' }))).rejects.toThrow(
        BadRequestException,
      );
      expect(repository.findManyBudgets).not.toHaveBeenCalled();
    });

    it('пустая страница не спрашивает расходы', async () => {
      repository.findManyBudgets.mockResolvedValue({ rows: [], total: 0 });

      await service.findAll(query());

      expect(repository.findExpenseTotalsByCategory).not.toHaveBeenCalled();
    });
  });

  describe('карточка', () => {
    it('отдаёт строки плана со `spent` и остатком', async () => {
      repository.findExpenseTotalsByCategory.mockResolvedValue(new Map([[OFFICE_ID, 1_510_000]]));

      const card = await service.findOne(BUDGET_ID);

      expect(card.lines[0]).toMatchObject({
        category: { id: OFFICE_ID, name: 'Офис' },
        allocated: 12_000,
        spent: 15_100,
        remaining: -3100,
        overspent: true,
      });
    });

    it('404 на неизвестный бюджет', async () => {
      repository.findBudgetById.mockResolvedValue(null);

      await expect(service.findOne(BUDGET_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('создание', () => {
    const dto = {
      name: 'Бюджет на I квартал 2026',
      periodFrom: '2026-01',
      periodTo: '2026-03',
      lines: [{ categoryId: OFFICE_ID, allocated: 12_000 }],
    };

    it('переводит период в первые числа месяцев, а суммы — в тыйины', async () => {
      await service.create(dto, ACCOUNT_ID);

      expect(repository.createBudget).toHaveBeenCalledWith(
        expect.objectContaining({
          periodFrom: new Date('2026-01-01T00:00:00.000Z'),
          periodTo: new Date('2026-03-01T00:00:00.000Z'),
          lines: [{ categoryId: OFFICE_ID, allocatedCents: 1_200_000, note: null }],
          createdById: EMPLOYEE_ID,
        }),
      );
    });

    it('план без строк допустим — статьи добавляют потом', async () => {
      await service.create({ ...dto, lines: undefined }, ACCOUNT_ID);

      expect(repository.createBudget).toHaveBeenCalledWith(expect.objectContaining({ lines: [] }));
    });

    it('однодневный период (один месяц) допустим', async () => {
      await service.create({ ...dto, periodTo: '2026-01' }, ACCOUNT_ID);

      expect(repository.createBudget).toHaveBeenCalled();
    });

    it('нулевой план по статье допустим', async () => {
      await service.create(
        { ...dto, lines: [{ categoryId: OFFICE_ID, allocated: 0 }] },
        ACCOUNT_ID,
      );

      expect(repository.createBudget).toHaveBeenCalledWith(
        expect.objectContaining({
          lines: [{ categoryId: OFFICE_ID, allocatedCents: 0, note: null }],
        }),
      );
    });

    it('аккаунт без профиля сотрудника не оставляет подписи', async () => {
      repository.findEmployeeByAccount.mockResolvedValue(null);

      await service.create(dto, ACCOUNT_ID);

      expect(repository.createBudget).toHaveBeenCalledWith(
        expect.objectContaining({ createdById: null }),
      );
    });

    it('409 на тёзку без учёта регистра — бюджет не заводится', async () => {
      repository.findBudgetByName.mockResolvedValue({
        id: 'other',
        name: 'Бюджет на I квартал 2026',
      });

      await expect(service.create(dto, ACCOUNT_ID)).rejects.toThrow(ConflictException);
      expect(repository.createBudget).not.toHaveBeenCalled();
    });

    it('400 на перевёрнутый период — до разбора строк', async () => {
      await expect(
        service.create({ ...dto, periodFrom: '2026-03', periodTo: '2026-01' }, ACCOUNT_ID),
      ).rejects.toThrow(BadRequestException);
      expect(repository.createBudget).not.toHaveBeenCalled();
    });

    it('400 на период длиннее потолка', async () => {
      await expect(
        service.create({ ...dto, periodFrom: '2026-01', periodTo: '2031-02' }, ACCOUNT_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('период ровно в потолок проходит', async () => {
      await service.create({ ...dto, periodFrom: '2026-01', periodTo: '2030-12' }, ACCOUNT_ID);

      expect(repository.createBudget).toHaveBeenCalled();
    });

    it('400 на несуществующий месяц периода', async () => {
      await expect(service.create({ ...dto, periodFrom: '2026-13' }, ACCOUNT_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('400 на повтор статьи в плане', async () => {
      await expect(
        service.create(
          {
            ...dto,
            lines: [
              { categoryId: OFFICE_ID, allocated: 100 },
              { categoryId: OFFICE_ID, allocated: 200 },
            ],
          },
          ACCOUNT_ID,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(repository.createBudget).not.toHaveBeenCalled();
    });

    it('422 на несуществующую статью — с перечислением только недостающих', async () => {
      repository.findCategoriesByIds.mockResolvedValue([]);

      await expect(service.create(dto, ACCOUNT_ID)).rejects.toThrow(BusinessRuleException);
      expect(repository.createBudget).not.toHaveBeenCalled();
    });

    it('422 на выведенную из работы статью', async () => {
      repository.findCategoriesByIds.mockResolvedValue([
        category({ status: DirectoryStatus.INACTIVE }),
      ]);

      await expect(service.create(dto, ACCOUNT_ID)).rejects.toThrow(BusinessRuleException);
      expect(repository.createBudget).not.toHaveBeenCalled();
    });

    it('422 на раздел и его подстатью в одном плане', async () => {
      // Расход по НДС попал бы и в строку «НДС», и в строку «Налоги», и сумма
      // строк перестала бы что-либо значить.
      repository.findCategoriesByIds.mockResolvedValue([
        category({ id: TAX_ID, name: 'Налоги' }),
        category({ id: VAT_ID, name: 'НДС', parentId: TAX_ID }),
      ]);

      await expect(
        service.create(
          {
            ...dto,
            lines: [
              { categoryId: TAX_ID, allocated: 30_000 },
              { categoryId: VAT_ID, allocated: 8000 },
            ],
          },
          ACCOUNT_ID,
        ),
      ).rejects.toThrow(BusinessRuleException);
      expect(repository.createBudget).not.toHaveBeenCalled();
    });

    it('две подстатьи одного раздела без самого раздела — не конфликт', async () => {
      repository.findCategoriesByIds.mockResolvedValue([
        category({ id: VAT_ID, name: 'НДС', parentId: TAX_ID }),
        category({ id: OFFICE_ID, name: 'Подоходный', parentId: TAX_ID }),
      ]);

      await service.create(
        {
          ...dto,
          lines: [
            { categoryId: VAT_ID, allocated: 8000 },
            { categoryId: OFFICE_ID, allocated: 5000 },
          ],
        },
        ACCOUNT_ID,
      );

      expect(repository.createBudget).toHaveBeenCalled();
    });
  });

  describe('правка', () => {
    it('не переданные поля до БД не доходят', async () => {
      await service.update(BUDGET_ID, { status: BudgetStatus.ACTIVE });

      expect(repository.updateBudget).toHaveBeenCalledWith(BUDGET_ID, {
        name: undefined,
        description: undefined,
        periodFrom: undefined,
        periodTo: undefined,
        status: BudgetStatus.ACTIVE,
        lines: undefined,
      });
    });

    it('пустой список строк очищает план', async () => {
      await service.update(BUDGET_ID, { lines: [] });

      expect(repository.updateBudget).toHaveBeenCalledWith(
        BUDGET_ID,
        expect.objectContaining({ lines: [] }),
      );
    });

    it('новый конец периода сверяется с началом из БД', async () => {
      // Передать можно один конец, и сравнивать его с пустотой значило бы
      // пропускать «поставили конец раньше существующего начала» (0008).
      await expect(service.update(BUDGET_ID, { periodTo: '2025-12' })).rejects.toThrow(
        BadRequestException,
      );
      expect(repository.updateBudget).not.toHaveBeenCalled();
    });

    it('переименование в себя не конфликт', async () => {
      await service.update(BUDGET_ID, { name: 'бюджет НА I квартал 2026' });

      expect(repository.findBudgetByName).not.toHaveBeenCalled();
      expect(repository.updateBudget).toHaveBeenCalled();
    });

    it('409 на чужое название', async () => {
      repository.findBudgetByName.mockResolvedValue({ id: 'other', name: 'Бюджет на год' });

      await expect(service.update(BUDGET_ID, { name: 'Бюджет на год' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('422 на правку закрытого плана', async () => {
      repository.findBudgetById.mockResolvedValue(row({ status: BudgetStatus.CLOSED }));

      await expect(service.update(BUDGET_ID, { name: 'Новое имя' })).rejects.toThrow(
        BusinessRuleException,
      );
      expect(repository.updateBudget).not.toHaveBeenCalled();
    });

    it('закрытый план принимает только возврат в работу', async () => {
      repository.findBudgetById.mockResolvedValue(row({ status: BudgetStatus.CLOSED }));

      await service.update(BUDGET_ID, { status: BudgetStatus.ACTIVE });

      expect(repository.updateBudget).toHaveBeenCalledWith(
        BUDGET_ID,
        expect.objectContaining({ status: BudgetStatus.ACTIVE }),
      );
    });

    it('422 на правку «заодно» с открытием закрытого плана', async () => {
      repository.findBudgetById.mockResolvedValue(row({ status: BudgetStatus.CLOSED }));

      await expect(
        service.update(BUDGET_ID, { status: BudgetStatus.ACTIVE, name: 'Новое имя' }),
      ).rejects.toThrow(BusinessRuleException);
    });

    it('422 на закрытие закрытого плана — статус не тот', async () => {
      repository.findBudgetById.mockResolvedValue(row({ status: BudgetStatus.CLOSED }));

      await expect(service.update(BUDGET_ID, { status: BudgetStatus.CLOSED })).rejects.toThrow(
        BusinessRuleException,
      );
    });

    it('404 до всех проверок', async () => {
      repository.findBudgetById.mockResolvedValue(null);

      await expect(service.update(BUDGET_ID, { name: 'Новое имя' })).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.findBudgetByName).not.toHaveBeenCalled();
    });
  });

  describe('удаление', () => {
    it('удаляет черновик и называет его', async () => {
      await expect(service.remove(BUDGET_ID)).resolves.toEqual({
        id: BUDGET_ID,
        name: 'Бюджет на I квартал 2026',
      });
      expect(repository.deleteBudget).toHaveBeenCalledWith(BUDGET_ID);
    });

    it('422 на удаление закрытого плана', async () => {
      repository.findBudgetById.mockResolvedValue(row({ status: BudgetStatus.CLOSED }));

      await expect(service.remove(BUDGET_ID)).rejects.toThrow(BusinessRuleException);
      expect(repository.deleteBudget).not.toHaveBeenCalled();
    });

    it('404 на неизвестный бюджет', async () => {
      repository.findBudgetById.mockResolvedValue(null);

      await expect(service.remove(BUDGET_ID)).rejects.toThrow(NotFoundException);
    });
  });
});
