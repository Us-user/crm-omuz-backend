import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AccountingPeriodStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { BusinessRuleException, parseCsv, SortOrder } from '../common';
import type { AccountingPeriodRow } from './accounting.repository';
import type { AccountingRepository } from './accounting.repository';
import { AccountingPeriodSortField, type AccountingPeriodsQueryDto } from './dto';
import { PeriodsService } from './periods.service';
import { PdfGeneratorService } from '../documents/pdf-generator.service';

const PERIOD_ID = randomUUID();
const ACCOUNT_ID = randomUUID();
const EMPLOYEE_ID = randomUUID();

const JULY = new Date('2026-07-01T00:00:00.000Z');
const SEPTEMBER = new Date('2026-09-01T00:00:00.000Z');
const OCTOBER = new Date('2026-10-01T00:00:00.000Z');

const decimal = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

const row = (overrides: Partial<AccountingPeriodRow> = {}): AccountingPeriodRow => ({
  id: PERIOD_ID,
  name: 'III квартал 2026',
  description: null,
  periodFrom: JULY,
  periodTo: SEPTEMBER,
  status: AccountingPeriodStatus.IN_PROGRESS,
  charged: null,
  paid: null,
  income: null,
  expense: null,
  salary: null,
  closedAt: null,
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
  closedBy: null,
  createdBy: { id: EMPLOYEE_ID, firstName: 'Аниса', lastName: 'Р.' },
  ...overrides,
});

/** Закрытый период со снимком: 1480 начислено, 1215 принято, 1302 в кассе. */
const archived = (overrides: Partial<AccountingPeriodRow> = {}): AccountingPeriodRow =>
  row({
    status: AccountingPeriodStatus.ARCHIVED,
    charged: decimal('1480.00'),
    paid: decimal('1215.00'),
    income: decimal('1302.00'),
    expense: decimal('428.00'),
    salary: decimal('610.00'),
    closedAt: new Date('2026-10-02T09:00:00.000Z'),
    closedBy: { id: EMPLOYEE_ID, firstName: 'Аниса', lastName: 'Р.' },
    ...overrides,
  });

const query = (overrides: Partial<AccountingPeriodsQueryDto> = {}): AccountingPeriodsQueryDto => ({
  page: 1,
  limit: 20,
  skip: 0,
  take: 20,
  sort: AccountingPeriodSortField.PeriodFrom,
  order: SortOrder.Desc,
  ...overrides,
});

describe('PeriodsService', () => {
  let repository: jest.Mocked<AccountingRepository>;
  let service: PeriodsService;

  beforeEach(() => {
    repository = {
      findManyPeriods: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findPeriodById: jest.fn().mockResolvedValue(row()),
      findPeriodByName: jest.fn().mockResolvedValue(null),
      findOverlappingPeriod: jest.fn().mockResolvedValue(null),
      createPeriod: jest.fn().mockResolvedValue(row()),
      updatePeriod: jest.fn().mockResolvedValue(row()),
      closePeriod: jest.fn().mockResolvedValue(archived()),
      reopenPeriod: jest.fn().mockResolvedValue(row()),
      deletePeriod: jest.fn().mockResolvedValue(undefined),
      aggregateCharges: jest.fn().mockResolvedValue({ chargedCents: 0, paidCents: 0 }),
      sumIncome: jest.fn().mockResolvedValue(0),
      sumExpenses: jest.fn().mockResolvedValue(0),
      sumSalaryPaid: jest.fn().mockResolvedValue(0),
      findMonthlyChargeTotals: jest.fn().mockResolvedValue([]),
      findIncomeFacts: jest.fn().mockResolvedValue([]),
      findExpenseFacts: jest.fn().mockResolvedValue([]),
      findSalaryFacts: jest.fn().mockResolvedValue([]),
      findEmployeeByAccount: jest.fn().mockResolvedValue({ id: EMPLOYEE_ID }),
    } as unknown as jest.Mocked<AccountingRepository>;

    service = new PeriodsService(repository, new PdfGeneratorService());
  });

  // ──────────────────────────────── Список ───────────────────────────────────

  describe('findAll', () => {
    it('период в работе считает числа на лету и помечает их живыми', async () => {
      repository.aggregateCharges.mockResolvedValue({
        chargedCents: 120_000,
        paidCents: 50_000,
      });
      repository.sumIncome.mockResolvedValue(60_000);
      repository.sumExpenses.mockResolvedValue(10_000);
      repository.sumSalaryPaid.mockResolvedValue(20_000);

      const page = await service.findAll(query());

      expect(page.items[0]).toMatchObject({
        status: AccountingPeriodStatus.IN_PROGRESS,
        statusTitle: 'В работе',
        frozen: false,
        months: 3,
        report: {
          charged: 1200,
          paid: 500,
          debt: 700,
          income: 600,
          expense: 100,
          salary: 200,
          net: 300,
        },
      });
    });

    it('закрытый период берёт числа из снимка и не спрашивает БД', async () => {
      repository.findManyPeriods.mockResolvedValue({ rows: [archived()], total: 1 });

      const page = await service.findAll(query());

      expect(page.items[0]).toMatchObject({
        frozen: true,
        statusTitle: 'Закрыт',
        report: { charged: 1480, paid: 1215, debt: 265, income: 1302, net: 264 },
      });
      expect(repository.aggregateCharges).not.toHaveBeenCalled();
      expect(repository.sumIncome).not.toHaveBeenCalled();
    });

    it('на странице из закрытых периодов агрегатов нет вовсе', async () => {
      repository.findManyPeriods.mockResolvedValue({
        rows: [archived(), archived({ id: randomUUID(), name: 'II квартал 2026' })],
        total: 2,
      });

      await service.findAll(query());

      expect(repository.sumExpenses).not.toHaveBeenCalled();
    });

    it('живые числа считаются каждому периоду по своему окну', async () => {
      repository.findManyPeriods.mockResolvedValue({
        rows: [row(), row({ id: randomUUID(), periodFrom: OCTOBER, periodTo: OCTOBER })],
        total: 2,
      });

      await service.findAll(query());

      expect(repository.sumIncome).toHaveBeenCalledTimes(2);
      // Правая граница включающая, поэтому в запрос уходит первое число
      // следующего месяца.
      expect(repository.sumIncome).toHaveBeenCalledWith(JULY, OCTOBER);
      expect(repository.sumIncome).toHaveBeenCalledWith(
        OCTOBER,
        new Date('2026-11-01T00:00:00.000Z'),
      );
    });

    it('передаёт фильтры и окно страницы в репозиторий', async () => {
      await service.findAll(
        query({
          status: AccountingPeriodStatus.ARCHIVED,
          from: '2026-01',
          to: '2026-12',
          search: 'квартал',
          skip: 20,
          take: 20,
        }),
      );

      expect(repository.findManyPeriods).toHaveBeenCalledWith(
        expect.objectContaining({
          status: AccountingPeriodStatus.ARCHIVED,
          from: new Date('2026-01-01T00:00:00.000Z'),
          to: new Date('2026-12-01T00:00:00.000Z'),
          search: 'квартал',
          skip: 20,
          take: 20,
        }),
      );
    });

    it('400 на несуществующий месяц фильтра — до запроса в БД', async () => {
      await expect(service.findAll(query({ from: '2026-13' }))).rejects.toThrow(
        BadRequestException,
      );
      expect(repository.findManyPeriods).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────── Карточка ─────────────────────────────────

  describe('findOne', () => {
    it('404 на неизвестный период', async () => {
      repository.findPeriodById.mockResolvedValue(null);

      await expect(service.findOne(PERIOD_ID)).rejects.toThrow(NotFoundException);
    });

    it('«начислено» берётся тем же агрегатом, что итоги списка оплат', async () => {
      await service.findOne(PERIOD_ID);

      expect(repository.aggregateCharges).toHaveBeenCalledWith({ from: JULY, to: OCTOBER });
    });
  });

  // ──────────────────────────────── Заведение ────────────────────────────────

  describe('create', () => {
    const body = { name: 'III квартал 2026', periodFrom: '2026-07', periodTo: '2026-09' };

    it('заводит период с подписью из токена', async () => {
      await service.create(body, ACCOUNT_ID);

      expect(repository.createPeriod).toHaveBeenCalledWith({
        name: 'III квартал 2026',
        description: null,
        periodFrom: JULY,
        periodTo: SEPTEMBER,
        createdById: EMPLOYEE_ID,
      });
    });

    it('аккаунт без профиля сотрудника не оставляет подписи', async () => {
      repository.findEmployeeByAccount.mockResolvedValue(null);

      await service.create(body, ACCOUNT_ID);

      expect(repository.createPeriod).toHaveBeenCalledWith(
        expect.objectContaining({ createdById: null }),
      );
    });

    it('409 на тёзку', async () => {
      repository.findPeriodByName.mockResolvedValue({ id: randomUUID(), name: 'III КВАРТАЛ 2026' });

      await expect(service.create(body, ACCOUNT_ID)).rejects.toThrow(ConflictException);
      expect(repository.createPeriod).not.toHaveBeenCalled();
    });

    it('422 на пересечение с уже заведённым периодом, и он назван', async () => {
      repository.findOverlappingPeriod.mockResolvedValue({
        id: randomUUID(),
        name: 'II полугодие 2026',
        periodFrom: JULY,
        periodTo: new Date('2026-12-01T00:00:00.000Z'),
      });

      await expect(service.create(body, ACCOUNT_ID)).rejects.toThrow(
        /пересекается с «II полугодие 2026» \(2026-07…2026-12\)/,
      );
      expect(repository.createPeriod).not.toHaveBeenCalled();
    });

    it('400 на перевёрнутый период — до проверки пересечения', async () => {
      await expect(
        service.create({ ...body, periodFrom: '2026-09', periodTo: '2026-07' }, ACCOUNT_ID),
      ).rejects.toThrow(BadRequestException);
      expect(repository.findOverlappingPeriod).not.toHaveBeenCalled();
    });

    it('400 на период длиннее потолка в 60 месяцев, и потолок назван', async () => {
      await expect(
        service.create({ ...body, periodFrom: '2020-01', periodTo: '2026-01' }, ACCOUNT_ID),
      ).rejects.toMatchObject({
        response: {
          message: 'Период отчёта слишком длинный',
          details: { periodTo: 'Максимум 60 месяцев, запрошено 73' },
        },
      });
      expect(repository.createPeriod).not.toHaveBeenCalled();
    });

    it('период ровно в потолок проходит', async () => {
      await service.create({ ...body, periodFrom: '2021-02', periodTo: '2026-01' }, ACCOUNT_ID);

      expect(repository.createPeriod).toHaveBeenCalled();
    });
  });

  // ───────────────────────────────── Правка ──────────────────────────────────

  describe('update', () => {
    it('не переданное поле до БД не доходит', async () => {
      await service.update(PERIOD_ID, { name: 'Q3 2026' });

      expect(repository.updatePeriod).toHaveBeenCalledWith(PERIOD_ID, {
        name: 'Q3 2026',
        description: undefined,
        periodFrom: undefined,
        periodTo: undefined,
      });
    });

    it('новый конец сверяется с началом из БД, а не с пустотой', async () => {
      await expect(service.update(PERIOD_ID, { periodTo: '2026-05' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('пересечение проверяется только при смене границ и без самого себя', async () => {
      await service.update(PERIOD_ID, { periodTo: '2026-10' });

      expect(repository.findOverlappingPeriod).toHaveBeenCalledWith(JULY, OCTOBER, PERIOD_ID);
    });

    it('правка одного названия пересечение не проверяет', async () => {
      await service.update(PERIOD_ID, { name: 'Q3 2026' });

      expect(repository.findOverlappingPeriod).not.toHaveBeenCalled();
    });

    it('переименование в себя конфликтом не считается', async () => {
      await service.update(PERIOD_ID, { name: 'III КВАРТАЛ 2026' });

      expect(repository.findPeriodByName).not.toHaveBeenCalled();
    });

    it('422 на правку закрытого периода', async () => {
      repository.findPeriodById.mockResolvedValue(archived());

      await expect(service.update(PERIOD_ID, { name: 'Q3' })).rejects.toThrow(
        BusinessRuleException,
      );
      expect(repository.updatePeriod).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────── Закрытие ─────────────────────────────────

  describe('close', () => {
    it('замораживает пять первичных чисел и подписывает закрытие', async () => {
      repository.aggregateCharges.mockResolvedValue({
        chargedCents: 148_000,
        paidCents: 121_500,
      });
      repository.sumIncome.mockResolvedValue(130_200);
      repository.sumExpenses.mockResolvedValue(42_800);
      repository.sumSalaryPaid.mockResolvedValue(61_000);

      await service.close(PERIOD_ID, ACCOUNT_ID);

      expect(repository.closePeriod).toHaveBeenCalledWith(PERIOD_ID, {
        facts: {
          chargedCents: 148_000,
          paidCents: 121_500,
          incomeCents: 130_200,
          expenseCents: 42_800,
          salaryCents: 61_000,
        },
        closedAt: expect.any(Date) as Date,
        closedById: EMPLOYEE_ID,
      });
    });

    it('ответ уже помечен снимком — числа больше не живые', async () => {
      const closed = await service.close(PERIOD_ID, ACCOUNT_ID);

      expect(closed).toMatchObject({ frozen: true, status: AccountingPeriodStatus.ARCHIVED });
    });

    it('пустой период закрывается: «операций не было» — законный отчёт', async () => {
      await service.close(PERIOD_ID, ACCOUNT_ID);

      expect(repository.closePeriod).toHaveBeenCalledWith(
        PERIOD_ID,
        expect.objectContaining({
          facts: {
            chargedCents: 0,
            paidCents: 0,
            incomeCents: 0,
            expenseCents: 0,
            salaryCents: 0,
          },
        }),
      );
    });

    it('409 на повторное закрытие — снимок не переписывается', async () => {
      repository.findPeriodById.mockResolvedValue(archived());

      await expect(service.close(PERIOD_ID, ACCOUNT_ID)).rejects.toThrow(ConflictException);
      expect(repository.closePeriod).not.toHaveBeenCalled();
    });

    it('404 до всех запросов', async () => {
      repository.findPeriodById.mockResolvedValue(null);

      await expect(service.close(PERIOD_ID, ACCOUNT_ID)).rejects.toThrow(NotFoundException);
      expect(repository.aggregateCharges).not.toHaveBeenCalled();
    });
  });

  describe('reopen', () => {
    it('гасит снимок и возвращает период в работу', async () => {
      repository.findPeriodById.mockResolvedValue(archived());
      repository.reopenPeriod.mockResolvedValue(row());

      const reopened = await service.reopen(PERIOD_ID);

      expect(repository.reopenPeriod).toHaveBeenCalledWith(PERIOD_ID);
      expect(reopened).toMatchObject({ frozen: false });
    });

    it('422 на снятие с незакрытого периода', async () => {
      await expect(service.reopen(PERIOD_ID)).rejects.toThrow(BusinessRuleException);
      expect(repository.reopenPeriod).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────── Удаление ─────────────────────────────────

  describe('remove', () => {
    it('удаляет период в работе и называет его', async () => {
      await expect(service.remove(PERIOD_ID)).resolves.toEqual({
        id: PERIOD_ID,
        name: 'III квартал 2026',
      });
      expect(repository.deletePeriod).toHaveBeenCalledWith(PERIOD_ID);
    });

    it('422 на удаление закрытого — сначала снимите закрытие', async () => {
      repository.findPeriodById.mockResolvedValue(archived());

      await expect(service.remove(PERIOD_ID)).rejects.toThrow(BusinessRuleException);
      expect(repository.deletePeriod).not.toHaveBeenCalled();
    });

    it('404 на неизвестный период', async () => {
      repository.findPeriodById.mockResolvedValue(null);

      await expect(service.remove(PERIOD_ID)).rejects.toThrow(NotFoundException);
    });
  });

  // ──────────────────────────────── Выгрузка ─────────────────────────────────

  describe('exportCsv', () => {
    const cellsOf = (csv: string): string[][] => parseCsv(csv).map((record) => record.values);

    it('строка на каждый месяц периода плюс итоговая', async () => {
      const file = await service.exportCsv(PERIOD_ID);
      const rows = cellsOf(file.content);

      expect(file.months).toBe(3);
      expect(rows.map((cells) => cells[0])).toEqual([
        'Месяц',
        '2026-07',
        '2026-08',
        '2026-09',
        'Итого',
      ]);
    });

    it('месячные строки собираются из четырёх выборок окном периода', async () => {
      await service.exportCsv(PERIOD_ID);

      expect(repository.findMonthlyChargeTotals).toHaveBeenCalledWith(JULY, OCTOBER);
      expect(repository.findIncomeFacts).toHaveBeenCalledWith(JULY, OCTOBER);
      expect(repository.findExpenseFacts).toHaveBeenCalledWith(JULY, OCTOBER);
      expect(repository.findSalaryFacts).toHaveBeenCalledWith(JULY, OCTOBER);
    });

    it('итог закрытого периода берётся из снимка, а не считается заново', async () => {
      repository.findPeriodById.mockResolvedValue(archived());

      const rows = cellsOf((await service.exportCsv(PERIOD_ID)).content);

      expect(rows.at(-1)).toEqual([
        'Итого',
        '1480.00',
        '1215.00',
        '265.00',
        '1302.00',
        '428.00',
        '610.00',
        '264.00',
      ]);
      expect(repository.aggregateCharges).not.toHaveBeenCalled();
    });

    it('у периода в работе итог считается агрегатами', async () => {
      repository.sumIncome.mockResolvedValue(50_000);

      const rows = cellsOf((await service.exportCsv(PERIOD_ID)).content);

      expect(rows.at(-1)?.[4]).toBe('500.00');
    });

    it('файл называется по периоду, а ASCII-имя — по его границам', async () => {
      const file = await service.exportCsv(PERIOD_ID);

      expect(file.fileName).toBe('Отчёт III квартал 2026.csv');
      expect(file.asciiFileName).toBe('accounting-period-2026-07-2026-09.csv');
    });

    it('404 до всех выборок', async () => {
      repository.findPeriodById.mockResolvedValue(null);

      await expect(service.exportCsv(PERIOD_ID)).rejects.toThrow(NotFoundException);
      expect(repository.findIncomeFacts).not.toHaveBeenCalled();
    });
  });
});
