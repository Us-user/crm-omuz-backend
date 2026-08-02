import { Injectable } from '@nestjs/common';

import { BusinessRuleException, formatIsoMonth } from '../common';
import { AccountingRepository } from './accounting.repository';
import { monthStartOf } from './periods';

/**
 * Защита закрытого периода от операций задним числом (решение пользователя,
 * 0033) — тот самый долг, который сессии 0029, 0030, 0031 и 0032 откладывали
 * четыре раза подряд («правка задним числом», «гонки кассы»).
 *
 * **Правило одно и формулируется одной фразой:** архивный период не принимает
 * операции, **датированные внутри него**. Дата операции — это то, по которому
 * она попадает в отчёт: `paidAt` платежа и выплаты зарплаты, `spentAt` расхода,
 * `month` начисления. Заведение, правка и удаление проверяются одинаково,
 * а у правки проверяются **обе** даты: перенести операцию **в** закрытый
 * период тоже нельзя.
 *
 * Отсюда следствие, которое стоит знать: платёж, датированный открытым днём,
 * принимается, даже если закрывает месяц обучения из архива. Деньги пришли
 * сегодня, и в кассу они попадают сегодняшним днём (различие плана и кассы,
 * 0030); отчёт закрытого периода при этом не двигается, потому что он снимок.
 * Запрещать такой платёж значило бы требовать открыть прошлый квартал ради
 * погашения старого долга — то есть мешать работе правилом, которого ТЗ
 * не задаёт (довод 0031 про план, который ничего не запрещает).
 *
 * Живёт отдельным сервисом, а не методом каждого из трёх: правило одно, и три
 * копии проверки разошлись бы в тексте отказа, а потом и в самой границе. Тот
 * же ход, что с общим `whereOf` (0013, 0025, 0028) и общим `aggregateCharges`
 * (0030).
 */
@Injectable()
export class PeriodGuardService {
  constructor(private readonly repository: AccountingRepository) {}

  /**
   * Проверяет день операции (`paidAt`, `spentAt`): он сводится к своему месяцу,
   * потому что периоды заданы месяцами.
   */
  assertDateOpen(date: Date, operation: string): Promise<void> {
    return this.assertMonthOpen(monthStartOf(date), operation);
  }

  /** То же для нескольких дат сразу — старой и новой при переносе операции. */
  async assertDatesOpen(dates: readonly Date[], operation: string): Promise<void> {
    const months = new Map(dates.map((date) => [monthStartOf(date).getTime(), monthStartOf(date)]));

    for (const month of months.values()) {
      await this.assertMonthOpen(month, operation);
    }
  }

  /**
   * Проверяет месяц напрямую — им пользуется начисление: у него месяц обучения
   * и есть дата, по которой оно попадает в отчёт.
   *
   * Запросов ровно один на проверку, и он ложится на индекс
   * `(status, periodFrom, periodTo)`. Отдельного кэша нет: закрытых периодов
   * у центра единицы, а кэш пришлось бы гасить при каждом снятии закрытия.
   */
  async assertMonthOpen(month: Date, operation: string): Promise<void> {
    const period = await this.repository.findArchivedPeriodForMonth(month);
    if (period === null) return;

    throw new BusinessRuleException(
      `${operation} за ${formatIsoMonth(month)} невозможно: финансовый период ` +
        `«${period.name}» (${formatIsoMonth(period.periodFrom)}…` +
        `${formatIsoMonth(period.periodTo)}) закрыт. ` +
        'Снимите закрытие, если запись действительно нужно изменить',
      {
        month: formatIsoMonth(month),
        periodId: period.id,
        periodName: period.name,
        periodFrom: formatIsoMonth(period.periodFrom),
        periodTo: formatIsoMonth(period.periodTo),
      },
    );
  }
}
