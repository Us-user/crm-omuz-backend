import { formatIsoMonth } from '../common';

/**
 * Покинувшие курсы (ТЗ 5.12) — чистые функции сведения.
 *
 * Своей модели у витрины нет: «покинул курс» — это членство `GroupStudent`
 * со статусом `LEFT`, причиной и датой (решение сессии 0012). Здесь только то,
 * чего в запросе нет, — раскладка уходов по месяцам и по разрезам.
 *
 * Считается в памяти, а не агрегатом БД, по двум причинам: помесячная группировка
 * в Prisma не выражается (нужен `date_trunc`, то есть сырой SQL), а четыре разреза
 * одного и того же набора — это четыре запроса вместо одного прохода. Отрезок
 * при этом ограничен сверху (`MAX_STATS_MONTHS`), поэтому набор не может вырасти
 * до «всей истории центра» случайно.
 */

/** Сколько месяцев показывает график, если период не задан. */
export const DEFAULT_STATS_MONTHS = 12;

/**
 * Потолок длины периода. Не про производительность запроса, а про размер ответа:
 * график из трёхсот столбцов не является графиком, а «выгрузить всё» не должно
 * получаться из пустого запроса.
 */
export const MAX_STATS_MONTHS = 60;

/** Именованная запись разреза: группа, курс или филиал. */
export interface NamedRef {
  id: string;
  name: string;
}

/** Один зафиксированный уход — ровно то, из чего складывается статистика. */
export interface LeftCourseFact {
  /** Дата ухода. Факты без даты в статистику не попадают: их не в какой месяц класть. */
  leftAt: Date;
  group: NamedRef;
  course: NamedRef;
  branch: NamedRef;
}

export interface MonthCount {
  month: string;
  count: number;
}

export interface GroupCount {
  group: NamedRef;
  course: NamedRef;
  count: number;
}

export interface RefCount {
  ref: NamedRef;
  count: number;
}

export interface LeftCoursesSummary {
  total: number;
  byMonth: MonthCount[];
  byGroup: GroupCount[];
  byCourse: RefCount[];
  byBranch: RefCount[];
}

/**
 * Сводит уходы в помесячный ряд и три разреза (ТЗ 5.12: «виды Students/Groups,
 * помесячный график»).
 *
 * Разрезов по причине ухода нет намеренно: причина — свободный текст (ТЗ 5.12),
 * и группировка по ней дала бы столько «категорий», сколько было операторов.
 *
 * Внутри разреза порядок — по убыванию числа уходов, при равенстве по названию:
 * первым читают самое проблемное, а устойчивость нужна, чтобы два вызова
 * с теми же данными давали один и тот же ответ.
 */
export function summarize(
  facts: readonly LeftCourseFact[],
  months: readonly string[],
): LeftCoursesSummary {
  const byMonth = new Map(months.map((month) => [month, 0]));
  const byGroup = new Map<string, GroupCount>();
  const byCourse = new Map<string, RefCount>();
  const byBranch = new Map<string, RefCount>();

  for (const fact of facts) {
    const month = formatIsoMonth(fact.leftAt);
    const current = byMonth.get(month);
    // Месяц вне отрезка не появляется: выборка ограничена теми же границами.
    // Условие оставлено, чтобы факт за его пределами не заводил столбец,
    // которого нет в ряду, — ряд задаёт ось графика, а не данные.
    if (current !== undefined) byMonth.set(month, current + 1);

    bump(byGroup, fact.group.id, () => ({ group: fact.group, course: fact.course, count: 0 }));
    bump(byCourse, fact.course.id, () => ({ ref: fact.course, count: 0 }));
    bump(byBranch, fact.branch.id, () => ({ ref: fact.branch, count: 0 }));
  }

  return {
    total: facts.length,
    byMonth: months.map((month) => ({ month, count: byMonth.get(month) ?? 0 })),
    byGroup: [...byGroup.values()].sort(
      (a, b) => b.count - a.count || compareText(a.group.name, b.group.name),
    ),
    byCourse: sortRefs(byCourse),
    byBranch: sortRefs(byBranch),
  };
}

/** Заводит запись разреза при первой встрече и увеличивает счётчик. */
const bump = <T extends { count: number }>(
  target: Map<string, T>,
  key: string,
  create: () => T,
): void => {
  const existing = target.get(key) ?? create();
  existing.count += 1;
  target.set(key, existing);
};

const sortRefs = (target: Map<string, RefCount>): RefCount[] =>
  [...target.values()].sort((a, b) => b.count - a.count || compareText(a.ref.name, b.ref.name));

/**
 * Сравнение названий без учёта локали: `localeCompare` зависит от окружения,
 * а порядок внутри одинаковых счётчиков должен быть одним и тем же везде.
 */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
