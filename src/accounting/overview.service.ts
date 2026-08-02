import { BadRequestException, Injectable } from '@nestjs/common';

import {
  formatIsoMonth,
  monthSequence,
  nextIsoMonth,
  parseIsoMonth,
  shiftIsoMonth,
} from '../common';
import { fromCents, totalsOf } from './accounting';
import { AccountingRepository } from './accounting.repository';
import type { OverviewDto, OverviewQueryDto } from './dto';
import {
  DEFAULT_OVERVIEW_MONTHS,
  MAX_OVERVIEW_MONTHS,
  monthlyMoney,
  summarizeCategories,
  summarizeGroupPayments,
} from './overview';

/** Разобранный период обзора: оба конца — первые числа месяцев, включительно. */
interface Period {
  from: Date;
  to: Date;
}

/**
 * Обзор бухгалтерии (ТЗ 5.16: «Обзор: Total payment / Paid / Not paid / Net;
 * Income vs Expense; Students payment по группам»).
 *
 * Своих таблиц у обзора нет — это витрина поверх начислений, платежей
 * и расходов. Ключевое, из чего следует всё остальное: **чисел два вида,
 * и путать их нельзя**. `charges` (Total/Paid/Not paid) считаются по месяцам
 * обучения — это план; `income` считается по дню, когда деньги пришли, —
 * это касса. `Net = income − expense` (решение пользователя, сессия 0030):
 * центр заработал столько, сколько получил, за вычетом потраченного, а не
 * столько, сколько выставил счетов.
 *
 * `charges` берутся тем же `aggregateCharges`, что и `meta.totals` списка
 * оплат: два экрана обязаны показывать одно число **по определению**,
 * а не по совпадению (приём 0013, 0025, 0026, 0029).
 */
@Injectable()
export class OverviewService {
  constructor(private readonly repository: AccountingRepository) {}

  async find(query: OverviewQueryDto): Promise<OverviewDto> {
    const period = this.period(query.from, query.to);
    const months = monthSequence(period.from, period.to);
    const toExclusive = nextIsoMonth(period.to);
    const chargeFilter = { from: period.from, to: toExclusive };

    const [charges, income, expenses, salaries, categories, groupFacts] = await Promise.all([
      this.repository.aggregateCharges(chargeFilter),
      this.repository.findIncomeFacts(period.from, toExclusive),
      this.repository.findExpenseFacts(period.from, toExclusive),
      this.repository.findSalaryFacts(period.from, toExclusive),
      this.repository.findCategoryNodes(),
      this.repository.findGroupChargeFacts(chargeFilter),
    ]);

    const groups = await this.repository.findGroupsByIds([
      ...new Set(groupFacts.map(({ groupId }) => groupId)),
    ]);

    const incomeCents = sum(income.map(({ cents }) => cents));
    const expenseCents = sum(expenses.map(({ cents }) => cents));
    const salaryCents = sum(salaries.map(({ cents }) => cents));

    return {
      period: {
        from: formatIsoMonth(period.from),
        to: formatIsoMonth(period.to),
        months: months.length,
      },
      charges: totalsOf(charges.chargedCents, charges.paidCents),
      income: fromCents(incomeCents),
      expense: fromCents(expenseCents),
      salary: fromCents(salaryCents),
      // Разность считается в тыйинах и переводится один раз: вычитание
      // округлённых сомони разошлось бы со столбцами графика на копейки.
      net: fromCents(incomeCents - expenseCents - salaryCents),
      byMonth: monthlyMoney(months, income, expenses, salaries),
      byCategory: summarizeCategories(
        expenses,
        new Map(categories.map((category) => [category.id, category])),
      ),
      byGroup: summarizeGroupPayments(
        groupFacts,
        new Map(groups.map((group) => [group.id, group])),
      ),
    };
  }

  /**
   * Период обзора: у графика оси не бывает открытой, поэтому недостающие концы
   * достраиваются — `to` до текущего месяца, `from` на год назад от `to`
   * (то же решение, что у статистики оттока, 0025).
   */
  private period(from?: string, to?: string): Period {
    const end = to === undefined ? currentMonthStart() : parseIsoMonth(to, 'to');
    const start =
      from === undefined
        ? shiftIsoMonth(end, -(DEFAULT_OVERVIEW_MONTHS - 1))
        : parseIsoMonth(from, 'from');

    if (start.getTime() > end.getTime()) {
      throw new BadRequestException({
        message: 'Начало периода позже его конца',
        details: { from: formatIsoMonth(start), to: formatIsoMonth(end) },
      });
    }

    const months = monthSequence(start, end).length;
    if (months > MAX_OVERVIEW_MONTHS) {
      throw new BadRequestException({
        message: `Слишком длинный период: максимум ${String(MAX_OVERVIEW_MONTHS)} месяцев`,
        details: { months, from: formatIsoMonth(start), to: formatIsoMonth(end) },
      });
    }

    return { from: start, to: end };
  }
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

const currentMonthStart = (): Date => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
};
