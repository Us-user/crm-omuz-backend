import { AttendanceMark, LessonType } from '@prisma/client';

/** Балл за приход (ТЗ 5.8: «приход = 1 балл»). */
export const ATTENDANCE_POINT = 1;

/** Потолок балла за домашнее задание (ТЗ 5.8: «Score (ДЗ, до 5)»). */
export const MAX_HOMEWORK_SCORE = 5;

/** День недели в том виде, в каком его видит правило подсчёта. */
export interface ScoredDay {
  id: string;
  type: LessonType;
}

/** Клетка журнала в том виде, в каком её видит правило подсчёта. */
export interface ScoredEntry {
  dayId: string;
  attendance: AttendanceMark | null;
  score: number | null;
}

/** Разложение итога недели по слагаемым — экран показывает их отдельно. */
export interface WeekScore {
  /** Σ(приходы). */
  attendance: number;
  /** Σ(ДЗ по дням). */
  homework: number;
  exam: number;
  bonus: number;
  /** `Σ(приходы) + Σ(ДЗ) + Exam + Bonus` (ТЗ 5.8). */
  sum: number;
}

/**
 * Опоздание считается приходом.
 *
 * ТЗ 5.8 говорит «приход = 1 балл» и нигде не оговаривает опоздавших, а ТЗ 5.2
 * различает `Late` и `Absent` только ради графика посещаемости. Человек, который
 * пришёл с опозданием, на занятии был — придуманный штраф был бы правилом,
 * которого не просили.
 */
export const isArrival = (mark: AttendanceMark | null): boolean =>
  mark === AttendanceMark.PRESENT || mark === AttendanceMark.LATE;

/**
 * Итог недели по одному студенту (ТЗ 5.8).
 *
 * Чистая функция без обращений к БД: правило начисления — самое дорогое место
 * фазы (на нём висят коины, рейтинг и категории активности), и проверяться оно
 * должно таблицей значений, а не поднятым приложением.
 *
 * **На экзамене приход не считается** (ТЗ 5.8) — за экзаменационный день балл
 * приходит отдельным слагаемым `exam`, и начислять за него ещё и приход
 * значило бы посчитать один день дважды. Домашнее задание при этом
 * засчитывается в любой день: ТЗ исключает из подсчёта только приход.
 *
 * Клетки удалённых дней в подсчёт не идут: их день больше не принадлежит
 * неделе, и балл за него был бы взят из ниоткуда.
 */
export function computeWeekScore(
  days: ScoredDay[],
  entries: ScoredEntry[],
  extra: { bonus: number; exam: number },
): WeekScore {
  const typeOf = new Map(days.map((day) => [day.id, day.type]));

  let attendance = 0;
  let homework = 0;

  for (const entry of entries) {
    const type = typeOf.get(entry.dayId);
    if (type === undefined) continue;

    if (type !== LessonType.EXAM && isArrival(entry.attendance)) {
      attendance += ATTENDANCE_POINT;
    }
    if (entry.score !== null) {
      homework += entry.score;
    }
  }

  return {
    attendance,
    homework,
    exam: extra.exam,
    bonus: extra.bonus,
    sum: attendance + homework + extra.exam + extra.bonus,
  };
}
