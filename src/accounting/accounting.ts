import type { Prisma } from '@prisma/client';

/**
 * Денежное правило платёжного контура (ТЗ 5.16) — чистые функции без Prisma
 * и без Nest, чтобы «сколько студент должен» проверялось таблицей значений,
 * а не поднятым приложением. Тот же ход, что с `computeWeekScore` (0018),
 * `averageScore` (0019) и `isCouponValidOn` (0027).
 *
 * **Все расчёты идут в тыйинах (копейках), а не в сомони.** Двоичная плавающая
 * точка не представляет 0.1 точно, и `1200.30 - 400.10` в ней даёт
 * `800.1999999999999` — в отчёте по долгам это выглядело бы как копейка долга
 * у полностью рассчитавшегося студента. Колонки объявлены `DECIMAL(12,2)`,
 * то есть третьего знака в данных не бывает, и целые тыйины покрывают весь
 * диапазон без потерь.
 */

/**
 * Потолок суммы под колонку `DECIMAL(12,2)` — как у стоимости курса (0007),
 * часовой ставки (0021) и купона (0027): без него число, не влезающее
 * в столбец, дошло бы до БД и вернулось 500.
 *
 * Живёт здесь, а не в DTO: его требуют и начисления, и платежи, а импорт
 * из соседнего DTO замкнул бы их в цикл — и декоратор `@Max()` получил бы
 * `undefined` (поймано e2e-тестом: «amount must not be greater than undefined»).
 */
export const MAX_MONEY_AMOUNT = 9_999_999_999;

/** Деньги в том виде, в каком они приходят из БД (`Decimal`) или из формы. */
export type MoneyLike = Prisma.Decimal | number | string;

/** Сомони → тыйины. Округление снимает шум `Number()` на третьем знаке. */
export const toCents = (value: MoneyLike): number => Math.round(Number(value) * 100);

/** Тыйины → сомони: наружу деньги уходят числом с двумя знаками. */
export const fromCents = (cents: number): number => Math.round(cents) / 100;

/**
 * Сколько по месяцу к оплате: начислено минус скидка (ТЗ 5.16: «скидки»).
 *
 * Ниже нуля не опускается: скидка больше начисления — это ошибка ввода,
 * которую сервис отклоняет, но правило не должно отвечать отрицательным
 * долгом даже на испорченных данных.
 */
export const dueCentsOf = (amount: MoneyLike, discount: MoneyLike): number =>
  Math.max(0, toCents(amount) - toCents(discount));

/**
 * Статус месяца (ТЗ 5.16: «статус помесячный», «Not paid = неоплаченный месяц»).
 *
 * Выводится, а не хранится: вторая копия того же факта разошлась бы с платежами
 * при первой же правке — то же соображение, что с «истёк» у купона (0027)
 * и флагом выданного сертификата (0026).
 */
export enum ChargeStatus {
  /** Оплачен полностью. Сюда же попадает месяц с полной скидкой: к оплате ноль. */
  Paid = 'PAID',
  /** Оплачен частично — деньги приняты, но остаток есть. */
  Partial = 'PARTIAL',
  /** «Not paid» из ТЗ 5.16: по месяцу не принято ничего. */
  NotPaid = 'NOT_PAID',
}

export const CHARGE_STATUS_TITLES: Record<ChargeStatus, string> = {
  [ChargeStatus.Paid]: 'Оплачен',
  [ChargeStatus.Partial]: 'Оплачен частично',
  [ChargeStatus.NotPaid]: 'Не оплачен',
};

export const chargeStatusOf = (dueCents: number, paidCents: number): ChargeStatus =>
  paidCents >= dueCents
    ? ChargeStatus.Paid
    : paidCents > 0
      ? ChargeStatus.Partial
      : ChargeStatus.NotPaid;

/** Итоги набора начислений (ТЗ 5.16: «Total payment / Paid / Not paid»). */
export interface PaymentTotals {
  /** Начислено с учётом скидок — «Total payment». */
  charged: number;
  /** Принято денег по этим месяцам — «Paid». */
  paid: number;
  /** Остаток — «Not paid». */
  debt: number;
}

/**
 * Итоги в сомони из сумм в тыйинах.
 *
 * Долг не уходит в минус: платёж по месяцу не может превышать его остаток
 * (правило сервиса), поэтому переплаты здесь быть не должно, но на испорченных
 * данных отчёт обязан показать ноль, а не отрицательное «Not paid».
 */
export const totalsOf = (chargedCents: number, paidCents: number): PaymentTotals => ({
  charged: fromCents(chargedCents),
  paid: fromCents(paidCents),
  debt: fromCents(Math.max(0, chargedCents - paidCents)),
});

/** Начислено и оплачено студентом за период — по **всем** его месяцам. */
export interface DebtorChargeTotals {
  studentId: string;
  chargedCents: number;
  paidCents: number;
}

/** Долг студента — агрегат по его **незакрытым** месяцам. */
export interface DebtorDebt {
  studentId: string;
  debtCents: number;
  unpaidMonths: number;
  oldestUnpaidMonth: Date | null;
}

/** Строка витрины должников (ТЗ 5.16: «Debtors»). Суммы — в тыйинах. */
export interface DebtorSummary {
  studentId: string;
  chargedCents: number;
  paidCents: number;
  debtCents: number;
  /** Непривязанные платежи студента — деньги, принятые вперёд (ТЗ 5.16). */
  prepaidCents: number;
  /** Сколько месяцев осталось не закрытыми полностью. */
  unpaidMonths: number;
  /** Самый ранний незакрытый месяц: с него начинается разговор о долге. */
  oldestUnpaidMonth: Date | null;
}

/**
 * Сведение агрегатов в витрину должников (ТЗ 5.16: «Debtor = сумма
 * неоплаченных месяцев»).
 *
 * Три входа отвечают на три разных вопроса и приходят тремя агрегатами БД:
 * `debts` — по **незакрытым** месяцам (сам долг, их число и самый ранний),
 * `totals` — по **всем** месяцам периода («начислено» и «выплачено» из ТЗ),
 * `prepaidByStudent` — принятые, но не разнесённые по месяцам деньги.
 *
 * В ответ идут только те, у кого долг больше нуля: витрина отвечает на вопрос
 * «кто должен», а рассчитавшийся студент — не должник. Предоплата при этом
 * долг **не гасит**, а показывается рядом: деньги приняты, но конкретный месяц
 * ими не закрыт, и бухгалтер должен видеть оба числа, а не одно вместо другого.
 *
 * Порядок — по убыванию долга, при равенстве закреплён идентификатором:
 * список постраничный, и без устойчивого порядка одна строка приходила бы
 * на двух страницах подряд (приём сессии 0024).
 */
export const summarizeDebtors = (
  debts: readonly DebtorDebt[],
  totals: ReadonlyMap<string, DebtorChargeTotals>,
  prepaidByStudent: ReadonlyMap<string, number>,
): DebtorSummary[] =>
  debts
    .filter((debt) => debt.debtCents > 0)
    .map((debt) => {
      const total = totals.get(debt.studentId);

      return {
        studentId: debt.studentId,
        // Начисленного за период не может быть меньше долга: долг — часть его.
        // Пустой агрегат означал бы рассинхронизацию, и показать долг честнее,
        // чем ноль начислений рядом с ненулевым остатком.
        chargedCents: total?.chargedCents ?? debt.debtCents,
        paidCents: total?.paidCents ?? 0,
        debtCents: debt.debtCents,
        prepaidCents: prepaidByStudent.get(debt.studentId) ?? 0,
        unpaidMonths: debt.unpaidMonths,
        oldestUnpaidMonth: debt.oldestUnpaidMonth,
      };
    })
    .sort((a, b) => b.debtCents - a.debtCents || a.studentId.localeCompare(b.studentId));
