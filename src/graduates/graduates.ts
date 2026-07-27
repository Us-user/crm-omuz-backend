import { GraduateEmployment } from '@prisma/client';

/**
 * Правила выпуска (ТЗ 5.11) — чистые функции, отдельно от модулей, которые их
 * применяют. Тот же ход, что с `deriveStudentStatus` (0014), `coinsForWeekSum`
 * (0018) и порогами категорий (0019): через границу модуля переходит правило,
 * а не сервис.
 */

/**
 * Сколько выпускников в каждом статусе трудоустройства (ТЗ 5.11: «счётчики
 * трудоустройства»).
 *
 * `unknown` — те, у кого статус ещё не выясняли. Он стоит отдельно, а не
 * сливается с `OPEN_TO_WORK`: «не спрашивали» и «ищет работу» — разные вещи,
 * и вторая завысила бы отчёт о трудоустройстве. То же соображение, что
 * с `unscored` в категориях активности (0019).
 */
export type GraduateEmploymentCounts = Record<GraduateEmployment, number> & {
  unknown: number;
};

const emptyCounts = (): GraduateEmploymentCounts => ({
  [GraduateEmployment.OPEN_TO_WORK]: 0,
  [GraduateEmployment.WORK]: 0,
  [GraduateEmployment.FREELANCER]: 0,
  [GraduateEmployment.FURTHER_EDUCATION]: 0,
  [GraduateEmployment.ENTREPRENEUR]: 0,
  unknown: 0,
});

/** Сколько выпускников в одном статусе — строка агрегата БД. */
export interface EmploymentTally {
  employment: GraduateEmployment | null;
  count: number;
}

/**
 * Раскладка агрегата по счётчикам (ТЗ 5.11).
 *
 * На вход идут пары «статус → сколько», а не список выпускников: считать это
 * должна БД, а не приложение, — иначе счётчики по всему центру требовали бы
 * прочитать всех выпускников целиком. Нули при этом остаются: статус, которого
 * ни у кого нет, обязан быть в ответе нулём, иначе экран не отличит «никого»
 * от «поле пропало».
 */
export function employmentCountsOf(tallies: readonly EmploymentTally[]): GraduateEmploymentCounts {
  const counts = emptyCounts();

  for (const { employment, count } of tallies) {
    if (employment === null) {
      counts.unknown += count;
    } else {
      counts[employment] += count;
    }
  }

  return counts;
}

/**
 * Дата выпуска (ТЗ 5.11: «автовыпуск при завершении срока группы»).
 *
 * Срок группы и есть дата завершения обучения, поэтому берётся `endDate`, если
 * он задан. Вычислять её из `startDate` и длительности нельзя — сессия 0008
 * отказалась от этого сознательно: «месяц от 31 января» неоднозначен, и любое
 * правило было бы выдумкой, зашитой в данные. Если срок не задан, остаётся
 * день, когда группу закрыли: это факт, а не догадка.
 *
 * Возвращается **календарная** дата (полночь UTC): колонка `@db.Date`, времени
 * в ней нет, и приводить его к полуночи должен тот, кто знает про колонку.
 */
export function graduationDateOf(groupEndDate: Date | null, closedAt: Date): Date {
  const source = groupEndDate ?? closedAt;

  return new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth(), source.getUTCDate()));
}
