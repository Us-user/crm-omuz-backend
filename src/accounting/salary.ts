import { SalaryStatus } from '@prisma/client';

import { fromCents } from './accounting';

/**
 * Зарплатное правило (ТЗ 5.16: «Salary: Total/Prepaid/Remaining/Paid; часы
 * по фактически проведённым занятиям × часовая ставка уровня месяца + Bonus»)
 * — чистые функции без Prisma и без Nest, как денежное правило кассы (0029),
 * свод обзора (0030) и свод бюджета (0031).
 *
 * Деньги считаются **в тыйинах** (правило 0029), а часы — **в минутах**.
 * Минуты не превращаются в часы до самого конца: `1.5 ч × 27 TJS` в двоичной
 * плавающей точке даёт копеечный хвост, а `90 мин × 2700 тыйин / 60` — целое
 * число. Наружу часы уходят делением на 60 с двумя знаками, и это значение
 * ни во что не умножается.
 */

/** Минут в часе. Названо константой, чтобы деление в коде читалось. */
export const MINUTES_PER_HOUR = 60;

/**
 * Потолок длительности одного занятия. Не правило ТЗ, а защита от лишнего
 * нуля в форме: сутки занятий — это опечатка, а не расписание, и без потолка
 * она превратилась бы в зарплату за 24 часа (тот же довод, что у потолков
 * `Bonus` и `Exam` в журнале, 0018).
 */
export const MAX_LESSON_MINUTES = 24 * MINUTES_PER_HOUR;

export const SALARY_STATUS_TITLES: Record<SalaryStatus, string> = {
  [SalaryStatus.DRAFT]: 'Черновик',
  [SalaryStatus.DONE]: 'Подтверждён',
};

/** Минуты → часы с двумя знаками. Значение только показывается, а не умножается. */
export const hoursOf = (minutes: number): number =>
  Math.round((minutes / MINUTES_PER_HOUR) * 100) / 100;

/**
 * Заработано за проведённые занятия: минуты × ставка, деление — последним
 * действием. Порядок важен: `hoursOf(90) * 2700` даёт 4050 тыйин и здесь,
 * но на `100 мин` округлённые до сотых часы уже теряют полтыйина, а зарплата
 * складывается из десятков таких строк.
 */
export const earnedCentsOf = (minutes: number, hourlyRateCents: number): number =>
  Math.round((minutes * hourlyRateCents) / MINUTES_PER_HOUR);

/**
 * Входные числа расчёта. У черновика они выводятся из журнала, уровня месяца
 * и заявок на аванс; у подтверждённого часы и ставка берутся из снимка.
 */
export interface SalaryInputs {
  /** Минуты фактически проведённых занятий за месяц (ТЗ 5.16). */
  minutes: number;
  /**
   * Часовая ставка уровня месяца в тыйинах. `null` — **уровня в этом месяце
   * не проставляли**, и это не «ставка ноль»: пробел обязан быть видимым,
   * чтобы ошибка нашлась до выплаты, а не после (правило 0021).
   */
  hourlyRateCents: number | null;
  bonusCents: number;
  /** Одобренные заявки на аванс этого месяца — «Prepaid» из ТЗ 5.16. */
  prepaidCents: number;
  /** Уже выплаченное по этому расчёту — «Paid». */
  paidCents: number;
}

/** Посчитанный расчёт: все четыре числа ТЗ 5.16 плюс их слагаемые. */
export interface SalaryComputed {
  minutes: number;
  hours: number;
  /** `null`, если уровня в месяце не было: тогда часы не превращаются в деньги. */
  hourlyRate: number | null;
  /** Заработанное часами, без премии. */
  earnedCents: number;
  bonusCents: number;
  /** «Total» = заработанное + премия. */
  totalCents: number;
  prepaidCents: number;
  paidCents: number;
  /** «Remaining» = `Total − Prepaid − Paid`. Может быть отрицательным. */
  remainingCents: number;
}

/**
 * Расчёт месяца по его входным числам.
 *
 * `Remaining` **не зажимается снизу нулём**, в отличие от долга студента
 * (0029): там переплата невозможна по построению (платёж не может превышать
 * остаток), а здесь аванс вполне может оказаться больше заработанного —
 * человек взял вперёд и заболел. Это законное состояние, и показать его минусом
 * честнее, чем нулём: ноль утверждал бы, что центр в расчёте (тот же довод,
 * что у перерасхода бюджета, 0031).
 *
 * Месяц без проставленного уровня даёт `earned = 0`, но не ноль `Total`:
 * премия остаётся премией. Подтвердить такой расчёт сервис не даст, если часы
 * есть, — иначе работу оплатили бы по несуществующей ставке.
 */
export function computeSalary(inputs: SalaryInputs): SalaryComputed {
  const earnedCents =
    inputs.hourlyRateCents === null ? 0 : earnedCentsOf(inputs.minutes, inputs.hourlyRateCents);
  const totalCents = earnedCents + inputs.bonusCents;

  return {
    minutes: inputs.minutes,
    hours: hoursOf(inputs.minutes),
    hourlyRate: inputs.hourlyRateCents === null ? null : fromCents(inputs.hourlyRateCents),
    earnedCents,
    bonusCents: inputs.bonusCents,
    totalCents,
    prepaidCents: inputs.prepaidCents,
    paidCents: inputs.paidCents,
    remainingCents: totalCents - inputs.prepaidCents - inputs.paidCents,
  };
}

/**
 * Числа **подтверждённого** расчёта — из снимка, а не пересчётом.
 *
 * `Total` берётся сохранённым, а `earned` выводится из него вычитанием премии:
 * пересчёт `минуты × ставка` дал бы то же число сегодня, но именно «то же
 * сегодня» и есть то, чего снимок обязан не обещать. Показывать надо ровно ту
 * сумму, которую человеку назвали при подтверждении.
 *
 * `Prepaid` и `Paid` в снимок **не** входят и остаются живыми: аванс могли
 * снять с рассмотрения (0031), а выплаты по расчёту продолжают приходить —
 * заморозить их значило бы показывать «выплачено 0» после первой же выплаты.
 */
export function frozenSalary(snapshot: {
  minutes: number;
  hourlyRateCents: number | null;
  totalCents: number;
  bonusCents: number;
  prepaidCents: number;
  paidCents: number;
}): SalaryComputed {
  return {
    minutes: snapshot.minutes,
    hours: hoursOf(snapshot.minutes),
    hourlyRate: snapshot.hourlyRateCents === null ? null : fromCents(snapshot.hourlyRateCents),
    earnedCents: snapshot.totalCents - snapshot.bonusCents,
    bonusCents: snapshot.bonusCents,
    totalCents: snapshot.totalCents,
    prepaidCents: snapshot.prepaidCents,
    paidCents: snapshot.paidCents,
    remainingCents: snapshot.totalCents - snapshot.prepaidCents - snapshot.paidCents,
  };
}

/** Четыре числа ведомости в сомони (ТЗ 5.16: «Total/Prepaid/Remaining/Paid»). */
export interface SalaryTotals {
  total: number;
  prepaid: number;
  paid: number;
  remaining: number;
}

/** Перевод посчитанного расчёта в сомони — одним местом на строку и на итоги. */
export const salaryTotalsOf = (computed: {
  totalCents: number;
  prepaidCents: number;
  paidCents: number;
  remainingCents: number;
}): SalaryTotals => ({
  total: fromCents(computed.totalCents),
  prepaid: fromCents(computed.prepaidCents),
  paid: fromCents(computed.paidCents),
  remaining: fromCents(computed.remainingCents),
});

/** Итоги ведомости — одни на все страницы, уходят в `meta.totals`. */
export interface SalarySheetTotals extends SalaryTotals {
  /** Сколько расчётов в отобранном наборе. */
  count: number;
  /** Сколько из них подтверждено (ТЗ 5.16: «Done»). */
  confirmed: number;
  /** Часы всех расчётов набора — сложение идёт в минутах. */
  hours: number;
}

/** Расчёт в своде: посчитанные числа плюс то, подтверждён ли он. */
export interface SalarySheetRow extends SalaryComputed {
  confirmed: boolean;
}

/**
 * Свод ведомости по всему отобранному набору, а не по странице: «сколько центр
 * должен выплатить за сентябрь» — вопрос ко всей ведомости, и ответ, зависящий
 * от размера страницы, не был бы ответом (приём 0029, 0030).
 *
 * Складываются **тыйины и минуты**, перевод в сомони и часы делается один раз
 * в конце: сумма округлённых сомони разошлась бы со строками на копейки (0030).
 */
export function summarizeSalaries(rows: readonly SalarySheetRow[]): SalarySheetTotals {
  let totalCents = 0;
  let prepaidCents = 0;
  let paidCents = 0;
  let remainingCents = 0;
  let minutes = 0;
  let confirmed = 0;

  for (const row of rows) {
    totalCents += row.totalCents;
    prepaidCents += row.prepaidCents;
    paidCents += row.paidCents;
    remainingCents += row.remainingCents;
    minutes += row.minutes;
    if (row.confirmed) confirmed += 1;
  }

  return {
    ...salaryTotalsOf({ totalCents, prepaidCents, paidCents, remainingCents }),
    count: rows.length,
    confirmed,
    hours: hoursOf(minutes),
  };
}

/**
 * Дневная строка расчёта (ТЗ 5.16: «Daily salaries») — учебный день журнала,
 * который провёл этот сотрудник.
 *
 * Своей таблицы у неё нет: `DailySalary` из карты сущностей ТЗ 4 был бы копией
 * журнала. День уже знает дату, группу, тип занятия и длительность, а ставка
 * одна на весь месяц — умножение делает вот эта функция.
 */
export interface SalaryDayFact {
  date: Date;
  minutes: number;
  group: { id: string; name: string } | null;
}

export interface SalaryDayTotal {
  date: Date;
  minutes: number;
  hours: number;
  group: { id: string; name: string } | null;
  /** Сколько заработано за этот день, в тыйинах; `0` при неизвестной ставке. */
  amountCents: number;
}

/**
 * Раскладка месяца по дням. Сумма дневных строк может разойтись с `earned`
 * на тыйин: каждая строка округляется отдельно, а месяц считается одним
 * умножением. Разница названа честно и **не** правится подгонкой последней
 * строки — иначе дневная строка перестала бы быть «часы × ставка».
 */
export const summarizeSalaryDays = (
  days: readonly SalaryDayFact[],
  hourlyRateCents: number | null,
): SalaryDayTotal[] =>
  days
    .slice()
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((day) => ({
      date: day.date,
      minutes: day.minutes,
      hours: hoursOf(day.minutes),
      group: day.group,
      amountCents: hourlyRateCents === null ? 0 : earnedCentsOf(day.minutes, hourlyRateCents),
    }));
