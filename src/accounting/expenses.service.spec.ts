import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DirectoryStatus, Prisma } from '@prisma/client';

import { BusinessRuleException } from '../common';
import type { AccountingRepository, ExpenseCategoryRow, ExpenseRow } from './accounting.repository';
import { ExpensesQueryDto } from './dto';
import { ExpensesService } from './expenses.service';

const EXPENSE_ID = '11111111-1111-1111-1111-111111111111';
const CATEGORY_ID = '22222222-2222-2222-2222-222222222222';
const CHILD_ID = '33333333-3333-3333-3333-333333333333';
const BRANCH_ID = '44444444-4444-4444-4444-444444444444';
const ACCOUNT_ID = '55555555-5555-5555-5555-555555555555';
const EMPLOYEE_ID = '66666666-6666-6666-6666-666666666666';

const row = (overrides: Partial<ExpenseRow> = {}): ExpenseRow => ({
  id: EXPENSE_ID,
  title: 'Аренда офиса за сентябрь',
  amount: new Prisma.Decimal('4500.00'),
  spentAt: new Date('2026-09-05T00:00:00.000Z'),
  note: null,
  createdAt: new Date('2026-09-05T09:00:00.000Z'),
  category: { id: CATEGORY_ID, name: 'Офис', parent: null },
  branch: null,
  createdBy: null,
  ...overrides,
});

const category = (overrides: Partial<ExpenseCategoryRow> = {}): ExpenseCategoryRow => ({
  id: CATEGORY_ID,
  name: 'Офис',
  description: null,
  parent: null,
  status: DirectoryStatus.ACTIVE,
  createdAt: new Date('2026-08-01T09:00:00.000Z'),
  _count: { children: 0, expenses: 0 },
  ...overrides,
});

const query = (overrides: Partial<ExpensesQueryDto> = {}): ExpensesQueryDto =>
  Object.assign(new ExpensesQueryDto(), overrides);

describe('ExpensesService', () => {
  let repository: jest.Mocked<
    Pick<
      AccountingRepository,
      | 'findManyExpenses'
      | 'findExpenseById'
      | 'createExpense'
      | 'updateExpense'
      | 'deleteExpense'
      | 'findCategoryById'
      | 'findChildCategoryIds'
      | 'findBranchById'
      | 'findEmployeeByAccount'
    >
  >;
  let service: ExpensesService;

  beforeEach(() => {
    repository = {
      findManyExpenses: jest.fn().mockResolvedValue({ rows: [row()], total: 1, sumCents: 450000 }),
      findExpenseById: jest.fn().mockResolvedValue(row()),
      createExpense: jest.fn().mockResolvedValue(row()),
      updateExpense: jest.fn().mockResolvedValue(row()),
      deleteExpense: jest.fn().mockResolvedValue(undefined),
      findCategoryById: jest.fn().mockResolvedValue(category()),
      findChildCategoryIds: jest.fn().mockResolvedValue([]),
      findBranchById: jest
        .fn()
        .mockResolvedValue({ id: BRANCH_ID, name: 'Sadbarg', status: 'ACTIVE' }),
      findEmployeeByAccount: jest.fn().mockResolvedValue({ id: EMPLOYEE_ID }),
    };

    service = new ExpensesService(repository as unknown as AccountingRepository);
  });

  describe('список', () => {
    it('отдаёт сумму набора в `meta.totals`, а не по странице', async () => {
      const page = await service.findAll(query());

      expect(page.meta).toMatchObject({ totals: { amount: 4500 } });
    });

    it('в строке — категория, её родитель и день платежа', async () => {
      repository.findManyExpenses.mockResolvedValue({
        rows: [
          row({
            category: { id: CHILD_ID, name: 'НДС', parent: { id: CATEGORY_ID, name: 'Налоги' } },
          }),
        ],
        total: 1,
        sumCents: 450000,
      });

      const { items } = await service.findAll(query());

      expect(items[0]).toMatchObject({
        category: { id: CHILD_ID, name: 'НДС' },
        categoryParent: { id: CATEGORY_ID, name: 'Налоги' },
        amount: 4500,
        spentAt: '2026-09-05',
      });
    });

    it('фильтр по разделу разворачивается в его подкатегории', async () => {
      repository.findChildCategoryIds.mockResolvedValue([CHILD_ID]);

      await service.findAll(query({ categoryId: CATEGORY_ID }));

      expect(repository.findManyExpenses).toHaveBeenCalledWith(
        expect.objectContaining({ categoryIds: [CATEGORY_ID, CHILD_ID] }),
      );
    });

    it('без фильтра по категории подкатегории не запрашиваются', async () => {
      await service.findAll(query());

      expect(repository.findChildCategoryIds).not.toHaveBeenCalled();
      expect(repository.findManyExpenses).toHaveBeenCalledWith(
        expect.objectContaining({ categoryIds: undefined }),
      );
    });

    it('период передаётся отрезком месяцев: `to` — не включающая граница', async () => {
      await service.findAll(query({ from: '2026-01', to: '2026-03' }));

      expect(repository.findManyExpenses).toHaveBeenCalledWith(
        expect.objectContaining({
          from: new Date('2026-01-01T00:00:00.000Z'),
          to: new Date('2026-04-01T00:00:00.000Z'),
        }),
      );
    });

    it('400 на несуществующий месяц — до запроса', async () => {
      await expect(service.findAll(query({ from: '2026-13' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.findManyExpenses).not.toHaveBeenCalled();
    });

    it('передаёт окно страницы и сортировку', async () => {
      await service.findAll(query({ page: 3, limit: 10 }));

      expect(repository.findManyExpenses).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });
  });

  describe('проведение расхода', () => {
    it('переводит сумму в тыйины и подписывает автором из токена', async () => {
      await service.create(
        { categoryId: CATEGORY_ID, title: 'Аренда офиса', amount: 4500.5 },
        ACCOUNT_ID,
      );

      expect(repository.createExpense).toHaveBeenCalledWith(
        expect.objectContaining({
          categoryId: CATEGORY_ID,
          amountCents: 450050,
          createdById: EMPLOYEE_ID,
        }),
      );
    });

    it('без `spentAt` берёт сегодняшний день без времени', async () => {
      await service.create({ categoryId: CATEGORY_ID, title: 'Аренда', amount: 100 }, ACCOUNT_ID);

      const { spentAt } = repository.createExpense.mock.calls[0][0];
      expect(spentAt.toISOString()).toMatch(/T00:00:00\.000Z$/);
    });

    it('422 на несуществующую категорию — расход не заводится', async () => {
      repository.findCategoryById.mockResolvedValue(null);

      await expect(
        service.create({ categoryId: CATEGORY_ID, title: 'Аренда', amount: 100 }, ACCOUNT_ID),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.createExpense).not.toHaveBeenCalled();
    });

    it('422 на выведенную из работы категорию', async () => {
      repository.findCategoryById.mockResolvedValue(category({ status: DirectoryStatus.INACTIVE }));

      await expect(
        service.create({ categoryId: CATEGORY_ID, title: 'Аренда', amount: 100 }, ACCOUNT_ID),
      ).rejects.toThrow(/выведена из работы/);
      expect(repository.createExpense).not.toHaveBeenCalled();
    });

    it('422 на несуществующий филиал', async () => {
      repository.findBranchById.mockResolvedValue(null);

      await expect(
        service.create(
          { categoryId: CATEGORY_ID, title: 'Аренда', amount: 100, branchId: BRANCH_ID },
          ACCOUNT_ID,
        ),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.createExpense).not.toHaveBeenCalled();
    });

    it('без филиала расход считается общим для центра', async () => {
      await service.create({ categoryId: CATEGORY_ID, title: 'Налог', amount: 100 }, ACCOUNT_ID);

      expect(repository.createExpense).toHaveBeenCalledWith(
        expect.objectContaining({ branchId: null }),
      );
      expect(repository.findBranchById).not.toHaveBeenCalled();
    });

    it('аккаунт без профиля сотрудника не оставляет подписи', async () => {
      repository.findEmployeeByAccount.mockResolvedValue(null);

      await service.create({ categoryId: CATEGORY_ID, title: 'Аренда', amount: 100 }, ACCOUNT_ID);

      expect(repository.createExpense).toHaveBeenCalledWith(
        expect.objectContaining({ createdById: null }),
      );
    });
  });

  describe('правка', () => {
    it('пустой `branchId` снимает привязку к филиалу', async () => {
      await service.update(EXPENSE_ID, { branchId: '' });

      expect(repository.updateExpense).toHaveBeenCalledWith(
        EXPENSE_ID,
        expect.objectContaining({ branchId: null }),
      );
      expect(repository.findBranchById).not.toHaveBeenCalled();
    });

    it('незаданные поля не трогаются', async () => {
      await service.update(EXPENSE_ID, { title: 'Аренда офиса за октябрь' });

      expect(repository.updateExpense).toHaveBeenCalledWith(EXPENSE_ID, {
        categoryId: undefined,
        title: 'Аренда офиса за октябрь',
        amountCents: undefined,
        spentAt: undefined,
        branchId: undefined,
        note: undefined,
      });
    });

    it('смена категории проверяется так же, как при создании', async () => {
      repository.findCategoryById.mockResolvedValue(category({ status: DirectoryStatus.INACTIVE }));

      await expect(service.update(EXPENSE_ID, { categoryId: CATEGORY_ID })).rejects.toThrow(
        /выведена из работы/,
      );
      expect(repository.updateExpense).not.toHaveBeenCalled();
    });

    it('404 на неизвестный расход — до записи', async () => {
      repository.findExpenseById.mockResolvedValue(null);

      await expect(service.update(EXPENSE_ID, { title: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.updateExpense).not.toHaveBeenCalled();
    });
  });

  describe('удаление', () => {
    it('удаляет расход и называет его в ответе', async () => {
      expect(await service.remove(EXPENSE_ID, { reason: 'Ошибочно проведён дважды' })).toEqual({
        id: EXPENSE_ID,
        title: 'Аренда офиса за сентябрь, 4500 TJS от 2026-09-05',
      });
      expect(repository.deleteExpense).toHaveBeenCalledWith(EXPENSE_ID);
    });

    it('404 на неизвестный расход — до записи', async () => {
      repository.findExpenseById.mockResolvedValue(null);

      await expect(service.remove(EXPENSE_ID, { reason: 'ошибка' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.deleteExpense).not.toHaveBeenCalled();
    });
  });
});
