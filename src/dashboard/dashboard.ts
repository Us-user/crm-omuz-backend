import { AttendanceMark, GraduateEmployment } from '@prisma/client';

import { fromCents } from '../accounting/accounting';
import { formatIsoMonth } from '../common';
import type { GraduateEmploymentCounts } from '../graduates/graduates';
import { isArrival } from '../group-journal/journal-scoring';
import { roundScore } from '../performance/performance';

/**
 * Дашборд (ТЗ 5.2) — чистые функции сведения.
 *
 * Своих таблиц у дашборда нет и быть не может: это **агрегатор** (ТЗ 5.2)
 * поверх журнала (0018), лидов (0027), кассы (0029–0030), выпускников (0026)
 * и оттока (0025). Всё, что здесь есть, — раскладки, которых нет в запросе:
 * помесячные ряды (в Prisma они не выражаются — нужен `date_trunc`, то есть
 * сырой SQL, которого в проекте нет) и производные доли.
 *
 * Правила, уже живущие в других модулях, **импортируются, а не повторяются**:
 * «опоздание — это приход» приходит из журнала (`isArrival`, 0018), округление
 * доли — из успеваемости (`roundScore`, 0019), перевод тыйинов в сомони —
 * из кассы (`fromCents`, 0029). Вторая копия любого из них разошлась бы
 * с первой, и дашборд показывал бы не то же число, что экран, на который
 * с него переходят.
 */

/**
 * Сколько месяцев показывают витрины дашборда, если период не задан.
 * Та же длина, что у графика оттока (0025) и обзора бухгалтерии (0030).
 */
export const DEFAULT_DASHBOARD_MONTHS = 12;

/**
 * Потолок длины периода. Не про скорость запроса, а про размер ответа: график
 * из трёхсот столбцов не является графиком, а «выгрузить всё» не должно
 * получаться из пустого запроса (тот же довод, что в 0025 и 0030).
 */
export const MAX_DASHBOARD_MONTHS = 60;

/** Именованная ссылка витрины: курс, группа или филиал. */
export interface NamedRef {
  id: string;
  name: string;
}

/** Столбец помесячного ряда со счётчиком — самая частая форма ответа дашборда. */
export interface MonthCount {
  month: string;
  count: number;
}

/**
 * Раскладка дат по месяцам ряда.
 *
 * Ряд задаётся снаружи (`monthSequence`), а не данными: месяц без единого
 * события обязан остаться в графике нулём, иначе расстояние между столбцами
 * перестаёт быть временем (правило 0025, повторённое в 0030 и 0034).
 *
 * Дата вне ряда молча отбрасывается — выборка ограничена теми же границами,
 * и заводить столбец, которого нет в оси, значило бы показывать период шире
 * запрошенного.
 */
export function countByMonth(months: readonly string[], dates: readonly Date[]): MonthCount[] {
  const totals = new Map(months.map((month) => [month, 0]));

  for (const date of dates) {
    const month = formatIsoMonth(date);
    const current = totals.get(month);
    if (current !== undefined) totals.set(month, current + 1);
  }

  return months.map((month) => ({ month, count: totals.get(month) ?? 0 }));
}

// ─────────────────────────── Посещаемость (ТЗ 5.2) ────────────────────────────

/** Отметка журнала в том виде, в каком её видит витрина: марка и её число. */
export interface AttendanceTally {
  mark: AttendanceMark;
  count: number;
}

/** Та же отметка вместе с датой занятия — для помесячного графика. */
export interface AttendanceFact extends AttendanceTally {
  /** Дата **учебного дня**, а не проставления отметки: столбец про занятие. */
  at: Date;
}

/**
 * Посещаемость за отрезок (ТЗ 5.2: «график Attendance (Late/Absent)»).
 *
 * `marked` — сколько клеток вообще отмечено. Неотмеченные (`null`) сюда
 * не доходят: «не отмечен» и «отсутствовал» разведены ещё сессией 0018,
 * и склеить их значило бы отчитаться о прогулах там, где просто не заполнили
 * журнал.
 */
export interface AttendanceTotals {
  present: number;
  late: number;
  absent: number;
  /** `present + late + absent` — знаменатель доли приходов. */
  marked: number;
  /** Доля приходов в процентах. `null` — отмеченных клеток нет. */
  attendanceRate: number | null;
}

/** Столбец графика посещаемости. */
export interface MonthAttendance extends AttendanceTotals {
  month: string;
}

/**
 * Сведение отметок в счётчики и долю приходов.
 *
 * «Пришёл» берётся тем же правилом, что и балл за приход: **опоздание — это
 * приход** (ТЗ 5.8, `isArrival` из журнала). Вторая трактовка рядом с первой
 * разошлась бы, а ТЗ 5.2 разделяет `Late` и `Absent` именно ради графика,
 * а не ради штрафа.
 */
export function tallyAttendance(tallies: readonly AttendanceTally[]): AttendanceTotals {
  const countOf = (mark: AttendanceMark): number =>
    tallies.filter((tally) => tally.mark === mark).reduce((total, tally) => total + tally.count, 0);

  const present = countOf(AttendanceMark.PRESENT);
  const late = countOf(AttendanceMark.LATE);
  const absent = countOf(AttendanceMark.ABSENT);
  const marked = present + late + absent;
  const arrivals = tallies
    .filter(({ mark }) => isArrival(mark))
    .reduce((total, { count }) => total + count, 0);

  return {
    present,
    late,
    absent,
    marked,
    // Та же формула и то же округление, что в витрине успеваемости (0019):
    // два экрана обязаны называть одну и ту же долю одним числом.
    attendanceRate: marked === 0 ? null : roundScore((arrivals / marked) * 100),
  };
}

/** Помесячная раскладка посещаемости: столбец на каждый месяц ряда. */
export function monthlyAttendance(
  months: readonly string[],
  facts: readonly AttendanceFact[],
): MonthAttendance[] {
  const byMonth = new Map<string, AttendanceTally[]>(months.map((month) => [month, []]));

  for (const fact of facts) {
    byMonth.get(formatIsoMonth(fact.at))?.push({ mark: fact.mark, count: fact.count });
  }

  return months.map((month) => ({
    month,
    ...tallyAttendance(byMonth.get(month) ?? []),
  }));
}

// ────────────────────────── Статистика лидов (ТЗ 5.2) ─────────────────────────

/**
 * Одно обращение в том виде, в каком его видит воронка.
 *
 * `at` — дата **обращения** (`Lead.createdAt`), а не месяц записи: строка
 * месяца отвечает на вопрос «что принесла реклама этого месяца», и обращение
 * сентября, записавшееся на ноябрь, относится к сентябрю (два периода разведены
 * ещё сессией 0027).
 */
export interface LeadFact {
  at: Date;
  /** Побывал на пробном дне (`LeadType.CLIENT`, ТЗ 5.7). */
  client: boolean;
  /** Переведён в студенты — правый конец воронки (0027, 0028). */
  converted: boolean;
  /** Метка рекламной ссылки. `null` — обращение пришло не по рекламе. */
  utmSource: string | null;
  course: NamedRef | null;
}

export interface LeadTotals {
  total: number;
  /** Обращения, оставшиеся на стадии `LEAD`. */
  leads: number;
  clients: number;
  converted: number;
  /** Доля дошедших до пробного дня, в процентах. `null` — обращений не было. */
  clientRate: number | null;
  /** Доля ставших студентами, в процентах. `null` — обращений не было. */
  conversionRate: number | null;
}

/**
 * Столбец воронки. Это **когорта**: `clients` и `converted` считаются среди
 * обращений **этого** месяца, а не среди перешедших в нём. Иначе строка месяца
 * отвечала бы сразу на два вопроса и не отвечала бы ни на один: «отдача рекламы
 * сентября» — это судьба сентябрьских обращений, чем бы она ни кончилась
 * в ноябре.
 */
export interface MonthLeads {
  month: string;
  total: number;
  clients: number;
  converted: number;
}

export interface LeadSourceCount {
  /** `null` — обращение без UTM-метки: пробел остаётся видимым, а не пропадает. */
  source: string | null;
  count: number;
}

export interface LeadCourseCount {
  /** `null` — курс в обращении не указан (поле необязательно, ТЗ 5.7). */
  course: NamedRef | null;
  count: number;
}

export interface LeadsSummary {
  totals: LeadTotals;
  byMonth: MonthLeads[];
  byUtmSource: LeadSourceCount[];
  byCourse: LeadCourseCount[];
}

/**
 * Воронка обращений (ТЗ 5.2: «статистика лидов»).
 *
 * **Разрез идёт по UTM-метке, а не по полю `source`.** Сессия 0027 отказалась
 * группировать `source` и была права: это свободный текст («по рекомендации
 * Фарруха»), и группировка дала бы столько «категорий», сколько было
 * операторов. UTM-метка — другое дело: она приходит из рекламной ссылки уже
 * разобранной, то есть это машинное значение из конечного набора, ради
 * которого метки и раскладывали тремя колонками. Свободный текст остаётся
 * доступен поиском в `GET /leads`.
 *
 * Порядок разрезов — по убыванию числа, при равенстве по названию: первым
 * читают самое крупное, а устойчивость нужна, чтобы два вызова с теми же
 * данными давали один ответ (приём 0024, 0025, 0030).
 */
export function summarizeLeads(
  facts: readonly LeadFact[],
  months: readonly string[],
): LeadsSummary {
  const byMonth = new Map<string, MonthLeads>(
    months.map((month) => [month, { month, total: 0, clients: 0, converted: 0 }]),
  );
  const bySource = new Map<string, LeadSourceCount>();
  const byCourse = new Map<string, LeadCourseCount>();

  let clients = 0;
  let converted = 0;

  for (const fact of facts) {
    if (fact.client) clients += 1;
    if (fact.converted) converted += 1;

    const column = byMonth.get(formatIsoMonth(fact.at));
    if (column !== undefined) {
      column.total += 1;
      if (fact.client) column.clients += 1;
      if (fact.converted) column.converted += 1;
    }

    // Ключ `null`-метки — пустая строка: обращений без рекламы много,
    // и они обязаны собраться в одну строку, а не рассыпаться.
    const sourceKey = fact.utmSource ?? '';
    const source = bySource.get(sourceKey) ?? { source: fact.utmSource, count: 0 };
    source.count += 1;
    bySource.set(sourceKey, source);

    const courseKey = fact.course?.id ?? '';
    const course = byCourse.get(courseKey) ?? { course: fact.course, count: 0 };
    course.count += 1;
    byCourse.set(courseKey, course);
  }

  const total = facts.length;

  return {
    totals: {
      total,
      leads: total - clients,
      clients,
      converted,
      clientRate: rateOf(clients, total),
      conversionRate: rateOf(converted, total),
    },
    byMonth: months.map(
      (month) => byMonth.get(month) ?? { month, total: 0, clients: 0, converted: 0 },
    ),
    byUtmSource: [...bySource.values()].sort(
      (a, b) => b.count - a.count || compareLabels(a.source, b.source),
    ),
    byCourse: [...byCourse.values()].sort(
      (a, b) => b.count - a.count || compareLabels(a.course?.name ?? null, b.course?.name ?? null),
    ),
  };
}

// ───────────────────── Доход за месяц со сравнением (ТЗ 5.2) ──────────────────

/**
 * Число месяца рядом с числом предыдущего месяца (ТЗ 5.2: «доход за месяц
 * со сравнением»).
 *
 * Суммы приходят в тыйинах и переводятся в сомони **после** вычитания:
 * разность округлённых сомони разошлась бы с самими числами на копейки
 * (правило 0029, повторённое в 0030).
 */
export interface MoneyChange {
  current: number;
  previous: number;
  /** `current − previous`. Отрицательное — законный ответ. */
  change: number;
  /**
   * Рост в процентах. `null`, когда предыдущий месяц равен нулю: «выросло
   * в бесконечность раз» — не число, и показывать вместо него ноль или 100 %
   * значило бы выдумать величину. Пробел остаётся видимым (приём 0019, 0021).
   */
  changePercent: number | null;
}

export function compareMoney(currentCents: number, previousCents: number): MoneyChange {
  return {
    current: fromCents(currentCents),
    previous: fromCents(previousCents),
    change: fromCents(currentCents - previousCents),
    changePercent:
      previousCents === 0
        ? null
        : roundScore(((currentCents - previousCents) / previousCents) * 100),
  };
}

// ──────────────────── Трудоустройство выпускников (ТЗ 5.2) ────────────────────

/**
 * Кого считать трудоустроенным (ТЗ 5.2: «блок Employed graduates»).
 *
 * `FURTHER_EDUCATION` сюда не входит: продолживший учёбу работу не нашёл
 * и не искал, и записать его в трудоустроенные значило бы завысить главный
 * показатель, ради которого блок и существует. `OPEN_TO_WORK` — тем более.
 */
export const EMPLOYED_STATUSES: readonly GraduateEmployment[] = [
  GraduateEmployment.WORK,
  GraduateEmployment.FREELANCER,
  GraduateEmployment.ENTREPRENEUR,
];

export interface EmploymentSummary {
  total: number;
  employment: GraduateEmploymentCounts;
  employed: number;
  /**
   * Доля трудоустроенных **среди тех, чей статус выяснен**, в процентах.
   *
   * Знаменатель — `total − unknown`, а не `total`: невыясненный статус
   * не означает «без работы», и включать его в знаменатель значило бы записать
   * в безработные всех, до кого не дозвонились. Ровно тот же довод, по которому
   * `unknown` вообще стоит отдельной строкой (0026). `null` — статус
   * не выяснен ни у кого.
   */
  employmentRate: number | null;
}

export function summarizeEmployment(counts: GraduateEmploymentCounts): EmploymentSummary {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const known = total - counts.unknown;
  const employed = EMPLOYED_STATUSES.reduce((sum, status) => sum + counts[status], 0);

  return { total, employment: counts, employed, employmentRate: rateOf(employed, known) };
}

/** Доля в процентах с двумя знаками. `null` на пустом знаменателе — не ноль. */
const rateOf = (part: number, whole: number): number | null =>
  whole === 0 ? null : roundScore((part / whole) * 100);

/**
 * Порядок строк разреза при равном числе: сначала названные, потом безымянная
 * («без UTM-метки», «курс не указан»), и внутри — по названию.
 *
 * Безымянная строка уходит вниз тем же правилом `nulls: 'last'`, которым в базе
 * сортируются вместимость аудитории (0007), дата ухода (0025) и балл выпускника
 * (0026): пробел обязан остаться **видимым**, но не должен занимать место
 * названного значения в голове списка.
 *
 * Сравнение идёт без учёта локали: `localeCompare` зависит от окружения,
 * а порядок должен быть одним и тем же везде (0025, 0030).
 */
const compareLabels = (a: string | null, b: string | null): number => {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  return a < b ? -1 : a > b ? 1 : 0;
};
