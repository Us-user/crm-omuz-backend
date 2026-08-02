import { AccountingPeriodStatus } from '@prisma/client';

import { formatCsv, formatIsoMonth } from '../common';
import { fromCents, totalsOf } from './accounting';

/**
 * Финансовые периоды-отчёты (ТЗ 5.16: «Accountant: финансовые периоды-отчёты
 * income/expense/paid/notpaid/net, закрытие Inprogress→Archive, выгрузка») —
 * чистые функции без Prisma и без Nest.
 *
 * Здесь живёт то, чего нет в запросе: сведение пяти первичных чисел в отчёт,
 * помесячная раскладка выгрузки и правило «какой период накрывает эту дату».
 *
 * Все суммы на входе — в тыйинах (правило 0029), наружу уходят сомони.
 */

/** Названия состояний периода — на языке интерфейса, как у бюджета (0031). */
export const ACCOUNTING_PERIOD_STATUS_TITLES: Record<AccountingPeriodStatus, string> = {
  [AccountingPeriodStatus.IN_PROGRESS]: 'В работе',
  [AccountingPeriodStatus.ARCHIVED]: 'Закрыт',
};

/**
 * Потолок длины периода — как у бюджета (0031) и обзора (0030). Дело
 * не в скорости запроса: отчёт на триста месяцев не является отчётом,
 * а «выгрузить всю историю центра» не должно получаться из пустого запроса.
 */
export const MAX_PERIOD_MONTHS = 60;

/**
 * Пять первичных чисел отчёта — ровно то, что замораживает снимок.
 *
 * `charged`/`paid` считаются по **месяцам обучения** (это план), `income`
 * и `salary` — по дню движения денег (это касса). Различие задано решением
 * 0030, и путать их нельзя: неоплаченный месяц увеличивает долг, но не
 * увеличивает приход, а предоплата — наоборот.
 */
export interface PeriodFacts {
  chargedCents: number;
  paidCents: number;
  incomeCents: number;
  expenseCents: number;
  salaryCents: number;
}

/** Отчёт периода в сомони (ТЗ 5.16: income/expense/paid/notpaid/net). */
export interface PeriodReport {
  /** «Total payment»: начислено за месяцы обучения периода, с учётом скидок. */
  charged: number;
  /** «Paid»: сколько по этим месяцам принято. */
  paid: number;
  /** «Not paid»: остаток по месяцам обучения периода. */
  debt: number;
  /** Принятые за период деньги по дню платежа, вместе с предоплатами. */
  income: number;
  /** Расходы центра — без зарплаты: она стоит отдельным числом (0032). */
  expense: number;
  /** Выплаченная за период зарплата, по дню выплаты. */
  salary: number;
  /** `income − expense − salary`. Отрицательный — законный ответ. */
  net: number;
}

/**
 * Сведение фактов в отчёт.
 *
 * `debt` и `net` **не хранятся** даже у закрытого периода: они выводятся
 * из тех же пяти чисел этой же функцией. Иначе архивный и текущий отчёты
 * считались бы двумя разными способами — и однажды разошлись бы в том, что
 * значит «итог», а не в самих данных. Тот же довод, по которому статус месяца
 * выводится, а не хранится (0029).
 *
 * `debt` берётся `totalsOf` — тем же правилом, что «Not paid» списка оплат
 * и обзора: три экрана обязаны считать долг одинаково по определению.
 */
export function periodReportOf(facts: PeriodFacts): PeriodReport {
  const totals = totalsOf(facts.chargedCents, facts.paidCents);

  return {
    charged: totals.charged,
    paid: totals.paid,
    debt: totals.debt,
    income: fromCents(facts.incomeCents),
    expense: fromCents(facts.expenseCents),
    salary: fromCents(facts.salaryCents),
    // Вычитание идёт в тыйинах и переводится один раз: разность округлённых
    // сомони разошлась бы со слагаемыми на копейки (правило 0029, 0030).
    net: fromCents(facts.incomeCents - facts.expenseCents - facts.salaryCents),
  };
}

/** Строка периода в том виде, в каком её хранит БД. `null` — снимка нет. */
export interface PeriodSnapshotRow {
  status: AccountingPeriodStatus;
  chargedCents: number | null;
  paidCents: number | null;
  incomeCents: number | null;
  expenseCents: number | null;
  salaryCents: number | null;
}

/**
 * Факты закрытого периода из снимка.
 *
 * Возвращает `null`, если снимка нет: у периода в работе числа считаются
 * агрегатами, а закрытый без снимка — состояние, которого быть не должно,
 * и подставлять вместо него нули значило бы выдать пустоту за отчёт
 * (тот же довод, что у «незакрытого месяца — не 404, а `closed: false`», 0024).
 */
export function frozenFactsOf(row: PeriodSnapshotRow): PeriodFacts | null {
  if (row.status !== AccountingPeriodStatus.ARCHIVED) return null;
  if (
    row.chargedCents === null ||
    row.paidCents === null ||
    row.incomeCents === null ||
    row.expenseCents === null ||
    row.salaryCents === null
  ) {
    return null;
  }

  return {
    chargedCents: row.chargedCents,
    paidCents: row.paidCents,
    incomeCents: row.incomeCents,
    expenseCents: row.expenseCents,
    salaryCents: row.salaryCents,
  };
}

/** Отрезок месяцев: обе границы — первые числа, обе включительно. */
export interface MonthRange {
  from: Date;
  to: Date;
}

/**
 * Пересекаются ли два отрезка месяцев.
 *
 * На этом держится правило «периоды отчётности не пересекаются»: один платёж,
 * попавший в два отчёта, дал бы два ответа на вопрос «сколько центр заработал»
 * (осознанно иначе, чем у бюджетов, 0031, — там пересечение законно, потому
 * что план отвечает на другой вопрос).
 */
export const rangesOverlap = (a: MonthRange, b: MonthRange): boolean =>
  a.from.getTime() <= b.to.getTime() && a.to.getTime() >= b.from.getTime();

/** Накрывает ли период этот месяц (первое число). */
export const rangeCoversMonth = (range: MonthRange, month: Date): boolean =>
  range.from.getTime() <= month.getTime() && range.to.getTime() >= month.getTime();

/**
 * Первое число месяца, в который попадает дата.
 *
 * Операции датируются днём (`paidAt`, `spentAt`), а периоды — месяцами,
 * поэтому проверка «попадает ли операция в закрытый период» сводит день
 * к его месяцу. Считается в UTC — как всё остальное в проекте (0021, 0024).
 */
export const monthStartOf = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));

// ─────────────────────────── Выгрузка отчёта (CSV) ───────────────────────────

/**
 * Заголовок выгрузки. Колонки идут в том же порядке, в каком числа стоят
 * в карточке: файл открывают рядом с экраном и сверяют глазами.
 */
export const PERIOD_CSV_HEADER = [
  'Месяц',
  'Начислено',
  'Оплачено',
  'Долг',
  'Приход',
  'Расход',
  'Зарплата',
  'Итог',
];

/** Помесячные факты выгрузки: ключ — `YYYY-MM`. */
export type MonthlyFacts = ReadonlyMap<string, PeriodFacts>;

/** Пустой месяц остаётся в ряду нулями — это и есть смысл ряда (0025, 0030). */
const EMPTY_FACTS: PeriodFacts = {
  chargedCents: 0,
  paidCents: 0,
  incomeCents: 0,
  expenseCents: 0,
  salaryCents: 0,
};

const csvNumber = (value: number): string => value.toFixed(2);

const csvRow = (label: string, report: PeriodReport): string[] => [
  label,
  csvNumber(report.charged),
  csvNumber(report.paid),
  csvNumber(report.debt),
  csvNumber(report.income),
  csvNumber(report.expense),
  csvNumber(report.salary),
  csvNumber(report.net),
];

/**
 * Выгрузка отчёта (ТЗ 5.16: «выгрузка») — помесячная раскладка плюс итоговая
 * строка. Тем же кодом CSV, что состав группы (0013) и лиды (0028): сессия 0013
 * прямо записала, что выгрузки бухгалтерии стоит делать им же, а два разбора
 * разошлись бы в мелочах — и один из файлов однажды открылся бы неправильно.
 *
 * **Итог приходит снаружи, а не складывается из строк.** У закрытого периода
 * он берётся из снимка, а месячные строки считаются по живым данным, поэтому
 * их сумма может разойтись с итогом — ровно то же осознанное расхождение, что
 * у дневной раскладки подтверждённой зарплаты (0032). Подгонять последнюю
 * строку под итог значило бы, что месяц перестал быть месяцем.
 */
export function formatPeriodCsv(
  months: readonly string[],
  monthly: MonthlyFacts,
  total: PeriodReport,
): string {
  const rows = months.map((month) =>
    csvRow(month, periodReportOf(monthly.get(month) ?? EMPTY_FACTS)),
  );

  return formatCsv([PERIOD_CSV_HEADER, ...rows, csvRow('Итого', total)], { bom: true });
}

/** Денежный факт выгрузки: сумма в тыйинах и день, по которому она попадает в месяц. */
export interface DatedCents {
  at: Date;
  cents: number;
}

/**
 * Раскладка фактов периода по месяцам ряда.
 *
 * Ряд задаётся снаружи (`monthSequence`), а не данными: месяц без единой
 * операции обязан остаться в выгрузке нулями, иначе расстояние между строками
 * перестаёт быть временем (правило 0025). Факт вне ряда молча отбрасывается —
 * выборка ограничена теми же границами, и заводить строку, которой нет в оси,
 * значило бы показывать период шире запрошенного.
 */
export function monthlyPeriodFacts(
  months: readonly string[],
  charges: readonly { month: Date; chargedCents: number; paidCents: number }[],
  income: readonly DatedCents[],
  expense: readonly DatedCents[],
  salary: readonly DatedCents[],
): Map<string, PeriodFacts> {
  const facts = new Map<string, PeriodFacts>(months.map((month) => [month, { ...EMPTY_FACTS }]));

  for (const charge of charges) {
    const bucket = facts.get(formatIsoMonth(charge.month));
    if (bucket === undefined) continue;
    bucket.chargedCents += charge.chargedCents;
    bucket.paidCents += charge.paidCents;
  }

  const add = (rows: readonly DatedCents[], key: keyof PeriodFacts): void => {
    for (const row of rows) {
      const bucket = facts.get(formatIsoMonth(monthStartOf(row.at)));
      if (bucket === undefined) continue;
      bucket[key] += row.cents;
    }
  };

  add(income, 'incomeCents');
  add(expense, 'expenseCents');
  add(salary, 'salaryCents');

  return facts;
}
