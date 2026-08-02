import { randomUUID } from 'node:crypto';

import { BusinessRuleException } from '../common';
import type { AccountingRepository } from './accounting.repository';
import { PeriodGuardService } from './period-guard.service';

const PERIOD_ID = randomUUID();

const JULY = new Date('2026-07-01T00:00:00.000Z');
const AUGUST = new Date('2026-08-01T00:00:00.000Z');
const SEPTEMBER = new Date('2026-09-01T00:00:00.000Z');

const archivedPeriod = {
  id: PERIOD_ID,
  name: 'III квартал 2026',
  periodFrom: JULY,
  periodTo: SEPTEMBER,
};

describe('PeriodGuardService', () => {
  let repository: jest.Mocked<AccountingRepository>;
  let guard: PeriodGuardService;

  beforeEach(() => {
    repository = {
      findArchivedPeriodForMonth: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<AccountingRepository>;

    guard = new PeriodGuardService(repository);
  });

  describe('открытый период', () => {
    it('операция проходит, когда закрытого периода нет', async () => {
      await expect(
        guard.assertDateOpen(new Date('2026-08-15T00:00:00.000Z'), 'Проведение расхода'),
      ).resolves.toBeUndefined();
    });

    it('день операции сводится к первому числу своего месяца', async () => {
      await guard.assertDateOpen(new Date('2026-08-15T00:00:00.000Z'), 'Приём оплаты');

      expect(repository.findArchivedPeriodForMonth).toHaveBeenCalledWith(AUGUST);
    });

    it('месяц начисления уходит в проверку как есть', async () => {
      await guard.assertMonthOpen(SEPTEMBER, 'Начисление месяца');

      expect(repository.findArchivedPeriodForMonth).toHaveBeenCalledWith(SEPTEMBER);
    });
  });

  describe('закрытый период', () => {
    beforeEach(() => {
      repository.findArchivedPeriodForMonth.mockResolvedValue(archivedPeriod);
    });

    it('422 с названием периода, его границами и подсказкой, что делать', async () => {
      await expect(
        guard.assertDateOpen(new Date('2026-08-15T00:00:00.000Z'), 'Проведение расхода'),
      ).rejects.toThrow(BusinessRuleException);

      await expect(
        guard.assertDateOpen(new Date('2026-08-15T00:00:00.000Z'), 'Проведение расхода'),
      ).rejects.toThrow(
        'Проведение расхода за 2026-08 невозможно: финансовый период ' +
          '«III квартал 2026» (2026-07…2026-09) закрыт. ' +
          'Снимите закрытие, если запись действительно нужно изменить',
      );
    });

    it('в `details` уходит и месяц операции, и сам период', async () => {
      await expect(guard.assertMonthOpen(AUGUST, 'Начисление месяца')).rejects.toMatchObject({
        response: {
          details: {
            month: '2026-08',
            periodId: PERIOD_ID,
            periodName: 'III квартал 2026',
            periodFrom: '2026-07',
            periodTo: '2026-09',
          },
        },
      });
    });

    it('название действия подставляется в отказ — сообщений столько же, сколько операций', async () => {
      await expect(guard.assertMonthOpen(AUGUST, 'Выплата зарплаты')).rejects.toThrow(
        /^Выплата зарплаты за 2026-08 невозможно/,
      );
    });
  });

  describe('две даты сразу (правка операции)', () => {
    it('проверяет обе: старую дату и новую', async () => {
      await guard.assertDatesOpen(
        [new Date('2026-08-15T00:00:00.000Z'), new Date('2026-10-05T00:00:00.000Z')],
        'Правка расхода',
      );

      expect(repository.findArchivedPeriodForMonth).toHaveBeenCalledTimes(2);
      expect(repository.findArchivedPeriodForMonth).toHaveBeenCalledWith(AUGUST);
      expect(repository.findArchivedPeriodForMonth).toHaveBeenCalledWith(
        new Date('2026-10-01T00:00:00.000Z'),
      );
    });

    it('перенос **в** закрытый период тоже отклоняется', async () => {
      // Старая дата в открытом октябре, новая — в закрытом августе.
      repository.findArchivedPeriodForMonth.mockImplementation((month: Date) =>
        Promise.resolve(month.getTime() === AUGUST.getTime() ? archivedPeriod : null),
      );

      await expect(
        guard.assertDatesOpen(
          [new Date('2026-10-05T00:00:00.000Z'), new Date('2026-08-15T00:00:00.000Z')],
          'Правка платежа',
        ),
      ).rejects.toThrow(BusinessRuleException);
    });

    it('два дня одного месяца спрашиваются один раз', async () => {
      await guard.assertDatesOpen(
        [new Date('2026-08-01T00:00:00.000Z'), new Date('2026-08-31T00:00:00.000Z')],
        'Правка расхода',
      );

      expect(repository.findArchivedPeriodForMonth).toHaveBeenCalledTimes(1);
    });

    it('пустой список дат не спрашивает БД вовсе', async () => {
      await guard.assertDatesOpen([], 'Правка расхода');

      expect(repository.findArchivedPeriodForMonth).not.toHaveBeenCalled();
    });
  });
});
