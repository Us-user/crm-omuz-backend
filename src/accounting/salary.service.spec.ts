import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, SalaryStatus } from '@prisma/client';

import { BusinessRuleException, SortOrder } from '../common';
import type { MonthLevel, SalaryRow } from './accounting.repository';
import type { AccountingRepository } from './accounting.repository';
import { SalarySortField } from './dto';
import { SalaryService } from './salary.service';

const SALARY_ID = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE_ID = '22222222-2222-4222-8222-222222222222';
const TYPE_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const AUTHOR_ID = '55555555-5555-4555-8555-555555555555';

const month = (iso = '2026-09'): Date => new Date(`${iso}-01T00:00:00.000Z`);

const row = (overrides: Partial<SalaryRow> = {}): SalaryRow => ({
  id: SALARY_ID,
  month: month(),
  bonus: new Prisma.Decimal('0.00'),
  note: null,
  status: SalaryStatus.DRAFT,
  minutes: null,
  hourlyRate: null,
  total: null,
  confirmedAt: null,
  createdAt: new Date('2026-10-01T09:00:00.000Z'),
  employee: {
    id: EMPLOYEE_ID,
    firstName: 'Фаррух',
    lastName: 'Раҳимов',
    phone: '+992901234567',
    branch: { id: 'b1', name: 'Sadbarg' },
  },
  confirmedBy: null,
  createdBy: null,
  ...overrides,
});

const level = (hourlyRateCents = 2700): MonthLevel => ({
  employeeId: EMPLOYEE_ID,
  levelId: 'lvl-1',
  levelName: 'Senior mentor',
  hourlyRateCents,
});

const setRow = (overrides: Partial<SalaryRow> = {}) => {
  const base = row(overrides);

  return {
    id: base.id,
    employeeId: base.employee.id,
    bonus: base.bonus,
    status: base.status,
    minutes: base.minutes,
    hourlyRate: base.hourlyRate,
    total: base.total,
  };
};

const query = (overrides: Record<string, unknown> = {}) =>
  ({
    page: 1,
    limit: 20,
    skip: 0,
    take: 20,
    sort: SalarySortField.Employee,
    order: SortOrder.Asc,
    ...overrides,
  }) as never;

describe('SalaryService', () => {
  let repository: jest.Mocked<AccountingRepository>;
  let service: SalaryService;

  beforeEach(() => {
    repository = {
      findManySalaries: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
      findSalarySetRows: jest.fn().mockResolvedValue([]),
      findSalaryById: jest.fn().mockResolvedValue(null),
      findTaughtMinutes: jest.fn().mockResolvedValue(new Map()),
      findMonthLevels: jest.fn().mockResolvedValue(new Map()),
      findApprovedAvansTotals: jest.fn().mockResolvedValue(new Map()),
      findSalaryPaidTotals: jest.fn().mockResolvedValue(new Map()),
      findTaughtDays: jest.fn().mockResolvedValue([]),
      findSalaryCandidates: jest.fn().mockResolvedValue([]),
      createSalaries: jest.fn().mockResolvedValue(0),
      updateSalary: jest.fn(),
      confirmSalary: jest.fn(),
      unconfirmSalary: jest.fn(),
      deleteSalary: jest.fn().mockResolvedValue(undefined),
      findSalaryTransactions: jest.fn().mockResolvedValue([]),
      countSalaryTransactions: jest.fn().mockResolvedValue(0),
      createSalaryTransaction: jest.fn(),
      findSalaryTransactionById: jest.fn().mockResolvedValue(null),
      deleteSalaryTransaction: jest.fn().mockResolvedValue(undefined),
      findEmployeeById: jest.fn().mockResolvedValue({
        id: EMPLOYEE_ID,
        firstName: 'Фаррух',
        lastName: 'Раҳимов',
        status: 'ACTIVE',
      }),
      findTypeById: jest
        .fn()
        .mockResolvedValue({ id: TYPE_ID, name: 'Наличные', status: 'ACTIVE' }),
      findEmployeeByAccount: jest.fn().mockResolvedValue({ id: AUTHOR_ID }),
    } as unknown as jest.Mocked<AccountingRepository>;

    service = new SalaryService(repository);
  });

  // ─────────────────────────────── Ведомость ──────────────────────────────────

  describe('findAll', () => {
    it('считает черновик по живым часам и ставке месяца', async () => {
      repository.findManySalaries.mockResolvedValue({ rows: [row()], total: 1 });
      repository.findSalarySetRows.mockResolvedValue([setRow()]);
      repository.findTaughtMinutes.mockResolvedValue(new Map([[EMPLOYEE_ID, 600]]));
      repository.findMonthLevels.mockResolvedValue(new Map([[EMPLOYEE_ID, level()]]));

      const result = await service.findAll(query());

      expect(result.items[0]).toMatchObject({
        hours: 10,
        hourlyRate: 27,
        earned: 270,
        total: 270,
        remaining: 270,
        level: { id: 'lvl-1', name: 'Senior mentor' },
      });
    });

    it('подтверждённый расчёт берёт числа из снимка, а не из журнала', async () => {
      const confirmed = row({
        status: SalaryStatus.DONE,
        minutes: 600,
        hourlyRate: new Prisma.Decimal('27.00'),
        total: new Prisma.Decimal('270.00'),
      });
      repository.findManySalaries.mockResolvedValue({ rows: [confirmed], total: 1 });
      repository.findSalarySetRows.mockResolvedValue([setRow(confirmed)]);
      // Журнал с тех пор переписали — снимок обязан устоять.
      repository.findTaughtMinutes.mockResolvedValue(new Map([[EMPLOYEE_ID, 9999]]));
      repository.findMonthLevels.mockResolvedValue(new Map([[EMPLOYEE_ID, level(9900)]]));

      const result = await service.findAll(query());

      expect(result.items[0]).toMatchObject({ hours: 10, hourlyRate: 27, total: 270 });
    });

    it('Prepaid берётся из одобренных авансов месяца', async () => {
      repository.findManySalaries.mockResolvedValue({ rows: [row()], total: 1 });
      repository.findSalarySetRows.mockResolvedValue([setRow()]);
      repository.findTaughtMinutes.mockResolvedValue(new Map([[EMPLOYEE_ID, 600]]));
      repository.findMonthLevels.mockResolvedValue(new Map([[EMPLOYEE_ID, level()]]));
      repository.findApprovedAvansTotals.mockResolvedValue(new Map([[EMPLOYEE_ID, 5000]]));

      const result = await service.findAll(query());

      expect(result.items[0]).toMatchObject({ prepaid: 50, remaining: 220 });
    });

    it('месяц без уровня оставляет ставку null и не превращает часы в деньги', async () => {
      repository.findManySalaries.mockResolvedValue({ rows: [row()], total: 1 });
      repository.findSalarySetRows.mockResolvedValue([setRow()]);
      repository.findTaughtMinutes.mockResolvedValue(new Map([[EMPLOYEE_ID, 600]]));

      const result = await service.findAll(query());

      expect(result.items[0]).toMatchObject({
        hours: 10,
        hourlyRate: null,
        earned: 0,
        level: null,
      });
    });

    it('итоги считаются по всему набору, а не по странице', async () => {
      repository.findManySalaries.mockResolvedValue({ rows: [row()], total: 3 });
      repository.findSalarySetRows.mockResolvedValue([
        setRow(),
        setRow({ id: 'x2' }),
        setRow({ id: 'x3' }),
      ]);
      repository.findTaughtMinutes.mockResolvedValue(new Map([[EMPLOYEE_ID, 600]]));
      repository.findMonthLevels.mockResolvedValue(new Map([[EMPLOYEE_ID, level()]]));

      const result = await service.findAll(query({ take: 1 }));

      expect(result.meta).toMatchObject({ totals: expect.objectContaining({ count: 3 }) });
    });

    it('без month берётся текущий месяц первым числом', async () => {
      await service.findAll(query());

      const [filter] = repository.findSalarySetRows.mock.calls[0] ?? [];
      const now = new Date();
      expect(filter?.month).toEqual(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
    });

    it('негодный месяц отклоняется до запросов', async () => {
      await expect(service.findAll(query({ month: '2026-13' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.findManySalaries).not.toHaveBeenCalled();
    });

    it('фильтры уходят в запрос', async () => {
      await service.findAll(
        query({ month: '2026-09', employeeId: EMPLOYEE_ID, branchId: 'b1', search: 'Рах' }),
      );

      expect(repository.findManySalaries).toHaveBeenCalledWith(
        expect.objectContaining({
          month: month(),
          employeeId: EMPLOYEE_ID,
          branchId: 'b1',
          search: 'Рах',
        }),
      );
    });

    it('пустая ведомость не спрашивает живые числа лишний раз', async () => {
      await service.findAll(query());

      expect(repository.findTaughtMinutes).toHaveBeenCalledWith(
        expect.any(Date),
        expect.any(Date),
        [],
      );
    });
  });

  // ──────────────────────────────── Карточка ──────────────────────────────────

  describe('findOne', () => {
    it('отдаёт дневную раскладку и выплаты', async () => {
      repository.findSalaryById.mockResolvedValue(row());
      repository.findMonthLevels.mockResolvedValue(new Map([[EMPLOYEE_ID, level()]]));
      repository.findTaughtMinutes.mockResolvedValue(new Map([[EMPLOYEE_ID, 90]]));
      repository.findTaughtDays.mockResolvedValue([
        {
          date: new Date('2026-09-07T00:00:00.000Z'),
          minutes: 90,
          group: { id: 'g', name: 'F-1' },
        },
      ]);
      repository.findSalaryTransactions.mockResolvedValue([
        {
          id: 't1',
          amount: new Prisma.Decimal('100.00'),
          paidAt: new Date('2026-10-05T00:00:00.000Z'),
          comment: null,
          createdAt: new Date('2026-10-05T10:00:00.000Z'),
          type: { id: TYPE_ID, name: 'Наличные' },
          createdBy: null,
        },
      ]);

      const card = await service.findOne(SALARY_ID);

      expect(card.days).toEqual([
        {
          date: '2026-09-07',
          group: { id: 'g', name: 'F-1' },
          minutes: 90,
          hours: 1.5,
          amount: 40.5,
        },
      ]);
      expect(card.transactions).toHaveLength(1);
      expect(card.transactions[0]).toMatchObject({ amount: 100, paidAt: '2026-10-05' });
    });

    it('дни читаются окном месяца: правая граница — первое число следующего', async () => {
      repository.findSalaryById.mockResolvedValue(row());

      await service.findOne(SALARY_ID);

      expect(repository.findTaughtDays).toHaveBeenCalledWith(
        month('2026-09'),
        month('2026-10'),
        EMPLOYEE_ID,
      );
    });

    it('404 на неизвестный расчёт', async () => {
      await expect(service.findOne(SALARY_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─────────────────────────── Формирование ведомости ─────────────────────────

  describe('create', () => {
    it('заводит расчёты кандидатам месяца и подписывает автором из токена', async () => {
      repository.findSalaryCandidates.mockResolvedValue([EMPLOYEE_ID, 'e2']);
      repository.createSalaries.mockResolvedValue(2);

      const result = await service.create({ month: '2026-09' }, ACCOUNT_ID);

      expect(repository.createSalaries).toHaveBeenCalledWith(
        month(),
        [EMPLOYEE_ID, 'e2'],
        AUTHOR_ID,
      );
      expect(result).toMatchObject({ month: '2026-09', created: 2, skipped: 0 });
    });

    it('повторный запуск не заводит второй строки: skipped считает пропущенных', async () => {
      repository.findSalaryCandidates.mockResolvedValue([EMPLOYEE_ID, 'e2', 'e3']);
      repository.createSalaries.mockResolvedValue(1);

      const result = await service.create({ month: '2026-09' }, ACCOUNT_ID);

      expect(result).toMatchObject({ created: 1, skipped: 2 });
    });

    it('кандидаты ищутся окном месяца', async () => {
      await service.create({ month: '2026-09' }, ACCOUNT_ID);

      expect(repository.findSalaryCandidates).toHaveBeenCalledWith(
        month('2026-09'),
        month('2026-10'),
        undefined,
      );
    });

    it('422 на несуществующего сотрудника — до поиска кандидатов', async () => {
      repository.findEmployeeById.mockResolvedValue(null);

      await expect(
        service.create({ month: '2026-09', employeeId: EMPLOYEE_ID }, ACCOUNT_ID),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.findSalaryCandidates).not.toHaveBeenCalled();
    });

    it('400 на негодный месяц до всех запросов', async () => {
      await expect(service.create({ month: '2026-9' }, ACCOUNT_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.createSalaries).not.toHaveBeenCalled();
    });

    it('аккаунт без профиля не оставляет подписи', async () => {
      repository.findEmployeeByAccount.mockResolvedValue(null);
      repository.findSalaryCandidates.mockResolvedValue([EMPLOYEE_ID]);

      await service.create({ month: '2026-09' }, ACCOUNT_ID);

      expect(repository.createSalaries).toHaveBeenCalledWith(month(), [EMPLOYEE_ID], null);
    });
  });

  // ───────────────────────────────── Правка ───────────────────────────────────

  describe('update', () => {
    it('переводит премию в тыйины', async () => {
      repository.findSalaryById.mockResolvedValue(row());
      repository.updateSalary.mockResolvedValue(row({ bonus: new Prisma.Decimal('200.00') }));

      await service.update(SALARY_ID, { bonus: 200 });

      expect(repository.updateSalary).toHaveBeenCalledWith(
        SALARY_ID,
        expect.objectContaining({ bonusCents: 20_000 }),
      );
    });

    it('непереданное поле до БД не доходит', async () => {
      repository.findSalaryById.mockResolvedValue(row());
      repository.updateSalary.mockResolvedValue(row());

      await service.update(SALARY_ID, { bonus: 100 });

      expect(repository.updateSalary).toHaveBeenCalledWith(SALARY_ID, {
        bonusCents: 10_000,
        note: undefined,
      });
    });

    it('пустая строка очищает примечание', async () => {
      repository.findSalaryById.mockResolvedValue(row());
      repository.updateSalary.mockResolvedValue(row());

      await service.update(SALARY_ID, { note: '' });

      expect(repository.updateSalary).toHaveBeenCalledWith(
        SALARY_ID,
        expect.objectContaining({ note: null }),
      );
    });

    it('422 на правку подтверждённого расчёта', async () => {
      repository.findSalaryById.mockResolvedValue(row({ status: SalaryStatus.DONE }));

      await expect(service.update(SALARY_ID, { bonus: 100 })).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
      expect(repository.updateSalary).not.toHaveBeenCalled();
    });

    it('404 до разбора тела', async () => {
      await expect(service.update(SALARY_ID, { bonus: 100 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ────────────────────────────── Подтверждение ───────────────────────────────

  describe('confirm', () => {
    beforeEach(() => {
      repository.findTaughtMinutes.mockResolvedValue(new Map([[EMPLOYEE_ID, 600]]));
      repository.findMonthLevels.mockResolvedValue(new Map([[EMPLOYEE_ID, level()]]));
      repository.confirmSalary.mockResolvedValue(row({ status: SalaryStatus.DONE }));
    });

    it('замораживает часы, ставку и итог', async () => {
      repository.findSalaryById.mockResolvedValue(row({ bonus: new Prisma.Decimal('200.00') }));

      await service.confirm(SALARY_ID, ACCOUNT_ID);

      expect(repository.confirmSalary).toHaveBeenCalledWith(
        SALARY_ID,
        expect.objectContaining({ minutes: 600, hourlyRateCents: 2700, totalCents: 47_000 }),
      );
    });

    it('подписывает подтвердившим из токена', async () => {
      repository.findSalaryById.mockResolvedValue(row());

      await service.confirm(SALARY_ID, ACCOUNT_ID);

      expect(repository.confirmSalary).toHaveBeenCalledWith(
        SALARY_ID,
        expect.objectContaining({ confirmedById: AUTHOR_ID }),
      );
    });

    it('422, если часы есть, а уровня месяца нет: ставки не существует', async () => {
      repository.findSalaryById.mockResolvedValue(row());
      repository.findMonthLevels.mockResolvedValue(new Map());

      await expect(service.confirm(SALARY_ID, ACCOUNT_ID)).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
      expect(repository.confirmSalary).not.toHaveBeenCalled();
    });

    it('расчёт без часов подтверждается и без уровня: одна премия', async () => {
      repository.findSalaryById.mockResolvedValue(row({ bonus: new Prisma.Decimal('150.00') }));
      repository.findMonthLevels.mockResolvedValue(new Map());
      repository.findTaughtMinutes.mockResolvedValue(new Map());

      await service.confirm(SALARY_ID, ACCOUNT_ID);

      expect(repository.confirmSalary).toHaveBeenCalledWith(
        SALARY_ID,
        expect.objectContaining({ minutes: 0, hourlyRateCents: null, totalCents: 15_000 }),
      );
    });

    it('409 на повторное подтверждение', async () => {
      repository.findSalaryById.mockResolvedValue(row({ status: SalaryStatus.DONE }));

      await expect(service.confirm(SALARY_ID, ACCOUNT_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(repository.confirmSalary).not.toHaveBeenCalled();
    });

    it('404 до записи', async () => {
      repository.findSalaryById.mockResolvedValue(null);

      await expect(service.confirm(SALARY_ID, ACCOUNT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('unconfirm', () => {
    it('возвращает расчёт в черновик', async () => {
      repository.findSalaryById.mockResolvedValue(row({ status: SalaryStatus.DONE }));
      repository.unconfirmSalary.mockResolvedValue(row());

      await service.unconfirm(SALARY_ID);

      expect(repository.unconfirmSalary).toHaveBeenCalledWith(SALARY_ID);
    });

    it('422 на снятие с неподтверждённого', async () => {
      repository.findSalaryById.mockResolvedValue(row());

      await expect(service.unconfirm(SALARY_ID)).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.unconfirmSalary).not.toHaveBeenCalled();
    });

    it('409 при наличии выплат: деньги выданы по согласованной сумме', async () => {
      repository.findSalaryById.mockResolvedValue(row({ status: SalaryStatus.DONE }));
      repository.countSalaryTransactions.mockResolvedValue(2);

      await expect(service.unconfirm(SALARY_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(repository.unconfirmSalary).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────── Выплата ──────────────────────────────────

  describe('pay', () => {
    const confirmed = row({
      status: SalaryStatus.DONE,
      minutes: 600,
      hourlyRate: new Prisma.Decimal('27.00'),
      total: new Prisma.Decimal('270.00'),
    });

    beforeEach(() => {
      repository.createSalaryTransaction.mockResolvedValue({
        id: 't1',
        amount: new Prisma.Decimal('100.00'),
        paidAt: new Date('2026-10-05T00:00:00.000Z'),
        comment: null,
        createdAt: new Date(),
        type: { id: TYPE_ID, name: 'Наличные' },
        createdBy: null,
      });
    });

    it('проводит выплату по подтверждённому расчёту', async () => {
      repository.findSalaryById.mockResolvedValue(confirmed);

      const result = await service.pay(
        SALARY_ID,
        { amount: 100, typeId: TYPE_ID, paidAt: '2026-10-05' },
        ACCOUNT_ID,
      );

      expect(repository.createSalaryTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          salaryId: SALARY_ID,
          amountCents: 10_000,
          typeId: TYPE_ID,
          createdById: AUTHOR_ID,
        }),
      );
      expect(result.amount).toBe(100);
    });

    it('день по умолчанию — сегодня без времени', async () => {
      repository.findSalaryById.mockResolvedValue(confirmed);

      await service.pay(SALARY_ID, { amount: 100, typeId: TYPE_ID }, ACCOUNT_ID);

      const [input] = repository.createSalaryTransaction.mock.calls[0] ?? [];
      expect(input?.paidAt.getUTCHours()).toBe(0);
    });

    it('422 на выплату по черновику: его сумма ещё меняется', async () => {
      repository.findSalaryById.mockResolvedValue(row());

      await expect(
        service.pay(SALARY_ID, { amount: 100, typeId: TYPE_ID }, ACCOUNT_ID),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.createSalaryTransaction).not.toHaveBeenCalled();
    });

    it('422 на выплату больше остатка — с названным остатком', async () => {
      repository.findSalaryById.mockResolvedValue(confirmed);

      await expect(
        service.pay(SALARY_ID, { amount: 300, typeId: TYPE_ID }, ACCOUNT_ID),
      ).rejects.toThrow(/270/);
      expect(repository.createSalaryTransaction).not.toHaveBeenCalled();
    });

    it('одобренный аванс уменьшает остаток и потолок выплаты', async () => {
      repository.findSalaryById.mockResolvedValue(confirmed);
      repository.findApprovedAvansTotals.mockResolvedValue(new Map([[EMPLOYEE_ID, 20_000]]));

      await expect(
        service.pay(SALARY_ID, { amount: 100, typeId: TYPE_ID }, ACCOUNT_ID),
      ).rejects.toBeInstanceOf(BusinessRuleException);
    });

    it('уже выплаченное вычитается из остатка', async () => {
      repository.findSalaryById.mockResolvedValue(confirmed);
      repository.findSalaryPaidTotals.mockResolvedValue(new Map([[SALARY_ID, 26_000]]));

      await expect(
        service.pay(SALARY_ID, { amount: 20, typeId: TYPE_ID }, ACCOUNT_ID),
      ).rejects.toBeInstanceOf(BusinessRuleException);

      await service.pay(SALARY_ID, { amount: 10, typeId: TYPE_ID }, ACCOUNT_ID);
      expect(repository.createSalaryTransaction).toHaveBeenCalled();
    });

    it('422 на несуществующий способ оплаты', async () => {
      repository.findSalaryById.mockResolvedValue(confirmed);
      repository.findTypeById.mockResolvedValue(null);

      await expect(
        service.pay(SALARY_ID, { amount: 100, typeId: TYPE_ID }, ACCOUNT_ID),
      ).rejects.toBeInstanceOf(BusinessRuleException);
    });

    it('422 на выведенный из работы способ оплаты', async () => {
      repository.findSalaryById.mockResolvedValue(confirmed);
      repository.findTypeById.mockResolvedValue({
        id: TYPE_ID,
        name: 'Старый банк',
        status: 'INACTIVE',
      } as never);

      await expect(
        service.pay(SALARY_ID, { amount: 100, typeId: TYPE_ID }, ACCOUNT_ID),
      ).rejects.toThrow(/выведен/);
    });
  });

  describe('removeTransaction', () => {
    it('отменяет выплату и называет её в ответе', async () => {
      repository.findSalaryTransactionById.mockResolvedValue({
        id: 't1',
        salaryId: SALARY_ID,
        amount: new Prisma.Decimal('500.00'),
        paidAt: new Date('2026-10-05T00:00:00.000Z'),
        comment: null,
        createdAt: new Date(),
        type: { id: TYPE_ID, name: 'Наличные' },
        createdBy: null,
      });

      const result = await service.removeTransaction('t1', { reason: 'Дубль' });

      expect(repository.deleteSalaryTransaction).toHaveBeenCalledWith('t1');
      expect(result.title).toBe('500 TJS от 2026-10-05');
    });

    it('404 на неизвестную выплату', async () => {
      await expect(service.removeTransaction('t1', { reason: 'Дубль' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('удаляет черновик', async () => {
      repository.findSalaryById.mockResolvedValue(row());

      const result = await service.remove(SALARY_ID);

      expect(repository.deleteSalary).toHaveBeenCalledWith(SALARY_ID);
      expect(result.title).toBe('Раҳимов Фаррух, 2026-09');
    });

    it('422 на удаление подтверждённого: сначала снимают подтверждение', async () => {
      repository.findSalaryById.mockResolvedValue(row({ status: SalaryStatus.DONE }));

      await expect(service.remove(SALARY_ID)).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.deleteSalary).not.toHaveBeenCalled();
    });

    it('409 на расчёт с выплатами', async () => {
      repository.findSalaryById.mockResolvedValue(row());
      repository.countSalaryTransactions.mockResolvedValue(1);

      await expect(service.remove(SALARY_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(repository.deleteSalary).not.toHaveBeenCalled();
    });

    it('404 на неизвестный расчёт', async () => {
      await expect(service.remove(SALARY_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
