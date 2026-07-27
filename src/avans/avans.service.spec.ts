import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AvansStatus, EmployeeStatus, Prisma } from '@prisma/client';

import { BusinessRuleException, SortOrder } from '../common';
import type { AvansRepository, AvansRequestRow } from './avans.repository';
import { AvansService } from './avans.service';
import { AvansQueryDto, AvansSortField } from './dto';

const EMPLOYEE_ID = '22222222-2222-2222-2222-222222222222';
const AVANS_ID = '33333333-3333-3333-3333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-4444-444444444444';
const AUTHOR_ID = '55555555-5555-5555-5555-555555555555';

const employee = {
  id: EMPLOYEE_ID,
  firstName: 'Фаррух',
  lastName: 'Раҳимов',
  status: EmployeeStatus.ACTIVE,
};

const row = (overrides: Partial<AvansRequestRow> = {}): AvansRequestRow => ({
  id: AVANS_ID,
  employeeId: EMPLOYEE_ID,
  amount: new Prisma.Decimal('500.00'),
  reason: 'Оплата аренды жилья',
  month: new Date('2026-09-01T00:00:00.000Z'),
  status: AvansStatus.PENDING,
  reviewedAt: null,
  reviewComment: null,
  createdAt: new Date('2026-08-29T10:00:00.000Z'),
  createdBy: { id: AUTHOR_ID, firstName: 'Нигина', lastName: 'Каримова' },
  reviewedBy: null,
  ...overrides,
});

const query = (overrides: Partial<AvansQueryDto> = {}): AvansQueryDto =>
  Object.assign(new AvansQueryDto(), overrides);

const body = { amount: 500, reason: 'Оплата аренды жилья', month: '2026-09' };

describe('AvansService', () => {
  let repository: jest.Mocked<
    Pick<
      AvansRepository,
      | 'findMany'
      | 'findByIdForEmployee'
      | 'findPending'
      | 'create'
      | 'delete'
      | 'findEmployee'
      | 'findEmployeeByAccount'
    >
  >;
  let service: AvansService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findByIdForEmployee: jest.fn().mockResolvedValue(row()),
      findPending: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(() => Promise.resolve(row())),
      delete: jest.fn().mockResolvedValue(undefined),
      findEmployee: jest.fn().mockResolvedValue(employee),
      findEmployeeByAccount: jest.fn().mockResolvedValue({ id: AUTHOR_ID }),
    };

    service = new AvansService(repository as unknown as AvansRepository);
  });

  // ────────────────────────────── Список ──────────────────────────────

  describe('Список заявок', () => {
    it('отдаёт сумму числом, а месяц как YYYY-MM', async () => {
      const result = await service.findAll(EMPLOYEE_ID, query());

      expect(result.items[0]).toMatchObject({ amount: 500, month: '2026-09' });
      expect(typeof result.items[0]?.amount).toBe('number');
    });

    it('у нерассмотренной заявки review равен null', async () => {
      const result = await service.findAll(EMPLOYEE_ID, query());

      expect(result.items[0]?.review).toBeNull();
      expect(result.items[0]?.status).toBe(AvansStatus.PENDING);
    });

    it('у рассмотренной заявки отдаёт кто, когда и с каким комментарием', async () => {
      repository.findMany.mockResolvedValue({
        rows: [
          row({
            status: AvansStatus.APPROVED,
            reviewedAt: new Date('2026-09-05T08:30:00.000Z'),
            reviewComment: 'Одобрено в полном объёме',
            reviewedBy: { id: AUTHOR_ID, firstName: 'Фаррух', lastName: 'Раҳимов' },
          }),
        ],
        total: 1,
      });

      const result = await service.findAll(EMPLOYEE_ID, query());

      expect(result.items[0]?.review).toEqual({
        reviewedBy: { id: AUTHOR_ID, firstName: 'Фаррух', lastName: 'Раҳимов' },
        reviewedAt: '2026-09-05T08:30:00.000Z',
        comment: 'Одобрено в полном объёме',
      });
    });

    it('по умолчанию отдаёт свежие заявки сверху', async () => {
      await service.findAll(EMPLOYEE_ID, query());

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ sort: AvansSortField.CreatedAt, order: SortOrder.Desc }),
      );
    });

    it('переводит фильтры from/to в первые числа месяцев и передаёт окно страницы', async () => {
      await service.findAll(
        EMPLOYEE_ID,
        query({ from: '2026-01', to: '2026-03', status: AvansStatus.APPROVED, page: 2, limit: 10 }),
      );

      expect(repository.findMany).toHaveBeenCalledWith({
        employeeId: EMPLOYEE_ID,
        status: AvansStatus.APPROVED,
        from: new Date('2026-01-01T00:00:00.000Z'),
        to: new Date('2026-03-01T00:00:00.000Z'),
        sort: AvansSortField.CreatedAt,
        order: SortOrder.Desc,
        skip: 10,
        take: 10,
      });
    });

    it('без периода границы до БД не доходят', async () => {
      await service.findAll(EMPLOYEE_ID, query());

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ from: undefined, to: undefined }),
      );
    });

    it('400 на несуществующий месяц в фильтре', async () => {
      await expect(service.findAll(EMPLOYEE_ID, query({ from: '2026-13' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('404 на неизвестного сотрудника — до запроса заявок', async () => {
      repository.findEmployee.mockResolvedValue(null);

      await expect(service.findAll(EMPLOYEE_ID, query())).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findMany).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────── Подача ──────────────────────────────

  describe('Подача заявки', () => {
    it('заводит заявку на сотрудника из адреса, месяц — первым числом', async () => {
      await service.create(EMPLOYEE_ID, body, ACCOUNT_ID);

      expect(repository.create).toHaveBeenCalledWith({
        employeeId: EMPLOYEE_ID,
        amount: 500,
        reason: 'Оплата аренды жилья',
        month: new Date('2026-09-01T00:00:00.000Z'),
        createdById: AUTHOR_ID,
      });
    });

    it('подписывает заявку автором из токена, а не из тела', async () => {
      await service.create(EMPLOYEE_ID, body, ACCOUNT_ID);

      expect(repository.findEmployeeByAccount).toHaveBeenCalledWith(ACCOUNT_ID);
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ createdById: AUTHOR_ID }),
      );
    });

    it('аккаунт без профиля сотрудника заводит заявку без подписи', async () => {
      repository.findEmployeeByAccount.mockResolvedValue(null);

      await service.create(EMPLOYEE_ID, body, ACCOUNT_ID);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ createdById: null }),
      );
    });

    it('новая заявка приходит в статусе PENDING и без рассмотрения', async () => {
      const created = await service.create(EMPLOYEE_ID, body, ACCOUNT_ID);

      expect(created.status).toBe(AvansStatus.PENDING);
      expect(created.review).toBeNull();
    });

    it('409 на вторую нерассмотренную заявку — с суммой и месяцем первой', async () => {
      repository.findPending.mockResolvedValue(
        row({ amount: new Prisma.Decimal('300.00'), month: new Date('2026-08-01T00:00:00.000Z') }),
      );

      await expect(service.create(EMPLOYEE_ID, body, ACCOUNT_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      // Сумма и месяц первой заявки в тексте: иначе оператор не поймёт, какая мешает.
      await expect(service.create(EMPLOYEE_ID, body, ACCOUNT_ID)).rejects.toThrow(/300.*2026-08/);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('рассмотренная заявка подаче следующей не мешает', async () => {
      // `findPending` смотрит только на PENDING — одобренная сюда не попадает.
      repository.findPending.mockResolvedValue(null);

      await expect(service.create(EMPLOYEE_ID, body, ACCOUNT_ID)).resolves.toBeDefined();
      expect(repository.findPending).toHaveBeenCalledWith(EMPLOYEE_ID);
    });

    it('422 на выведенного из штата сотрудника — заявка не заводится', async () => {
      repository.findEmployee.mockResolvedValue({ ...employee, status: EmployeeStatus.INACTIVE });

      await expect(service.create(EMPLOYEE_ID, body, ACCOUNT_ID)).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
      expect(repository.create).not.toHaveBeenCalled();
      // Проверка статуса идёт до всего остального: нерассмотренную не ищем.
      expect(repository.findPending).not.toHaveBeenCalled();
    });

    it('400 на несуществующий месяц — до поиска нерассмотренной заявки', async () => {
      await expect(
        service.create(EMPLOYEE_ID, { ...body, month: '2026-13' }, ACCOUNT_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.findPending).not.toHaveBeenCalled();
    });

    it('404 на неизвестного сотрудника — до разбора тела', async () => {
      repository.findEmployee.mockResolvedValue(null);

      await expect(service.create(EMPLOYEE_ID, body, ACCOUNT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('позиция «Mentor» для подачи не спрашивается', async () => {
      await service.create(EMPLOYEE_ID, body, ACCOUNT_ID);

      // Правило держалось бы на переименуемом названии позиции (0010, 0020, 0021).
      expect(repository.findEmployee).toHaveBeenCalledWith(EMPLOYEE_ID);
      expect(repository.create).toHaveBeenCalled();
    });
  });

  // ────────────────────────────── Отзыв ──────────────────────────────

  describe('Отзыв заявки', () => {
    it('отзывает нерассмотренную и называет сумму с месяцем', async () => {
      const result = await service.remove(EMPLOYEE_ID, AVANS_ID);

      expect(repository.delete).toHaveBeenCalledWith(AVANS_ID);
      expect(result).toEqual({
        id: AVANS_ID,
        employeeId: EMPLOYEE_ID,
        amount: 500,
        month: '2026-09',
      });
    });

    it('заявка ищется вместе с сотрудником из пути', async () => {
      await service.remove(EMPLOYEE_ID, AVANS_ID);

      expect(repository.findByIdForEmployee).toHaveBeenCalledWith(AVANS_ID, EMPLOYEE_ID);
    });

    it.each([AvansStatus.APPROVED, AvansStatus.DENIED])(
      '422 на отзыв заявки в статусе %s — она уже вошла в расчёт месяца',
      async (status) => {
        repository.findByIdForEmployee.mockResolvedValue(
          row({ status, reviewedAt: new Date('2026-09-05T08:30:00.000Z') }),
        );

        await expect(service.remove(EMPLOYEE_ID, AVANS_ID)).rejects.toBeInstanceOf(
          BusinessRuleException,
        );
        expect(repository.delete).not.toHaveBeenCalled();
      },
    );

    it('404 на заявку другого сотрудника', async () => {
      repository.findByIdForEmployee.mockResolvedValue(null);

      await expect(service.remove(EMPLOYEE_ID, AVANS_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('различает «нет сотрудника» и «нет заявки»', async () => {
      repository.findEmployee.mockResolvedValue(null);
      await expect(service.remove(EMPLOYEE_ID, AVANS_ID)).rejects.toThrow('Сотрудник не найден');

      repository.findEmployee.mockResolvedValue(employee);
      repository.findByIdForEmployee.mockResolvedValue(null);
      await expect(service.remove(EMPLOYEE_ID, AVANS_ID)).rejects.toThrow(
        'Заявка на аванс не найдена у этого сотрудника',
      );
    });

    it('уволенному сотруднику ошибочную заявку отозвать можно', async () => {
      // Запрет касается только новых заявок: прошлые остаются, и их надо чем-то
      // править — та же асимметрия, что у INACTIVE ступени уровня (0021).
      repository.findEmployee.mockResolvedValue({ ...employee, status: EmployeeStatus.INACTIVE });

      await expect(service.remove(EMPLOYEE_ID, AVANS_ID)).resolves.toBeDefined();
      expect(repository.delete).toHaveBeenCalledWith(AVANS_ID);
    });
  });
});
