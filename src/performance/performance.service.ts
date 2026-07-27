import { Injectable, NotFoundException } from '@nestjs/common';
import { AttendanceMark } from '@prisma/client';

import { formatIsoDate } from '../common';
import { isArrival } from '../group-journal/journal-scoring';
import type {
  PerformanceAttendanceDto,
  PerformanceGroupDto,
  PerformanceRankDto,
  PerformanceWeekDto,
  StudentPerformanceDto,
} from './dto';
import {
  ACTIVITY_CATEGORY_TITLES,
  activityCategoryOf,
  averageScore,
  isPassing,
  roundScore,
} from './performance';
import type {
  AttendanceTally,
  RankedAverage,
  StudentMembershipRow,
  StudentWeekResultRow,
} from './performance.repository';
import { PerformanceRepository } from './performance.repository';

/**
 * Успеваемость студента (ТЗ 5.3: `GET /students/{id}/performance`).
 *
 * Витрина поверх журнала: своих данных у неё нет, всё выводится из `WeekResult`
 * и `JournalEntry`. Общий балл — среднее `Sum` по **финализированным** неделям
 * (ТЗ 5.8, решение сессии 0019), из него — категория активности (ТЗ 5.5),
 * место в рейтинге и корона (ТЗ 5.13).
 *
 * Кэша (`Performance` из карты сущностей ТЗ 4) нет намеренно: балл считается
 * агрегатом на лету, поэтому правка журнала видна в рейтинге сразу
 * и второго источника истины о том же числе не возникает.
 */
@Injectable()
export class PerformanceService {
  constructor(private readonly repository: PerformanceRepository) {}

  async findStudentPerformance(studentId: string): Promise<StudentPerformanceDto> {
    const student = await this.repository.findStudent(studentId);
    if (!student) {
      throw new NotFoundException('Студент не найден');
    }

    const [results, memberships, attendance, ranked] = await Promise.all([
      this.repository.findFinalizedResults(studentId),
      this.repository.findMemberships(studentId),
      this.repository.aggregateAttendance(studentId),
      this.repository.findRankedAverages(),
    ]);

    // Неокруглённое значение: по нему считаются место и корона, а округление —
    // дело показа. Сравнивать округлённые числа значило бы объявить первыми
    // сразу двоих, чьи баллы отличаются в третьем знаке.
    const average = averageScore(results.map(({ sum }) => sum));

    return {
      student,
      averageScore: average === null ? null : roundScore(average),
      category: activityCategoryOf(average),
      categoryTitle: titleOf(average),
      passing: isPassing(average),
      weeksCount: results.length,
      rank: rankOf(studentId, average, ranked),
      attendance: attendanceOf(attendance),
      groups: groupBreakdown(memberships, results),
      weeks: results.map(toWeekDto(memberships)),
    };
  }
}

const titleOf = (score: number | null): string | null => {
  const category = activityCategoryOf(score);

  return category === null ? null : ACTIVITY_CATEGORY_TITLES[category];
};

/**
 * Место в рейтинге (ТЗ 5.13) и корона (ТЗ 5.3).
 *
 * Место — это «сколько студентов строго выше, плюс один»: при равенстве баллов
 * оба занимают одно и то же место, и корона достаётся обоим. Придуманное
 * правило разрыва ничьей (по фамилии, по дате зачисления) поставило бы одного
 * из двух одинаково успевающих ниже без всякого основания.
 *
 * Студент, которого нет в выборке рейтинга, места не получает: либо он больше
 * не учится (решение сессии 0019), либо у него нет ни одной закрытой недели.
 */
function rankOf(
  studentId: string,
  average: number | null,
  ranked: RankedAverage[],
): PerformanceRankDto {
  const own = ranked.find((row) => row.studentId === studentId);

  if (own === undefined || average === null) {
    return { position: null, totalRanked: ranked.length, isTopStudent: false, ranked: false };
  }

  const better = ranked.filter((row) => row.average > own.average).length;

  return {
    position: better + 1,
    totalRanked: ranked.length,
    isTopStudent: better === 0,
    ranked: true,
  };
}

function attendanceOf(tallies: AttendanceTally[]): PerformanceAttendanceDto {
  const countOf = (mark: AttendanceMark): number =>
    tallies.find((tally) => tally.attendance === mark)?.count ?? 0;

  const present = countOf(AttendanceMark.PRESENT);
  const late = countOf(AttendanceMark.LATE);
  const absent = countOf(AttendanceMark.ABSENT);
  const marked = present + late + absent;

  // «Пришёл» берётся тем же правилом, что и балл за приход: опоздание —
  // это приход (ТЗ 5.8). Вторая трактовка рядом с первой разошлась бы.
  const arrivals = tallies
    .filter(({ attendance }) => isArrival(attendance))
    .reduce((total, { count }) => total + count, 0);

  return {
    present,
    late,
    absent,
    marked,
    attendanceRate: marked === 0 ? null : roundScore((arrivals / marked) * 100),
  };
}

/**
 * Разрез по группам. Идёт от **членств**, а не от итогов недель: группа,
 * в которой студент учится, но ни одной недели ещё не закрыли, обязана быть
 * в списке с баллом `null` — иначе «мои группы» и «моя успеваемость» показывали
 * бы разный состав, и пропажу группы читали бы как ошибку.
 */
function groupBreakdown(
  memberships: StudentMembershipRow[],
  results: StudentWeekResultRow[],
): PerformanceGroupDto[] {
  const sumsByGroup = new Map<string, number[]>();
  for (const result of results) {
    const sums = sumsByGroup.get(result.week.groupId) ?? [];
    sums.push(result.sum);
    sumsByGroup.set(result.week.groupId, sums);
  }

  return memberships.map(({ status, group }) => {
    const sums = sumsByGroup.get(group.id) ?? [];
    const average = averageScore(sums);

    return {
      groupId: group.id,
      groupName: group.name,
      courseId: group.course.id,
      courseTitle: group.course.title,
      membershipStatus: status,
      averageScore: average === null ? null : roundScore(average),
      category: activityCategoryOf(average),
      categoryTitle: titleOf(average),
      weeksCount: sums.length,
    };
  });
}

/**
 * Название группы берётся из членств: неделя ссылается на группу, но тянуть
 * её вложенным `select` ради строки, которая уже пришла с членствами, значило
 * бы читать одно и то же дважды.
 *
 * `null` в названии — не оплошность: итоги в неделе остаются и после того, как
 * студента убрали из состава группы (решение сессии 0018 — отметка ссылается
 * на студента, а не на членство). Тогда членства нет, и придумывать название
 * не из чего; идентификатор группы при этом на месте.
 */
const toWeekDto =
  (memberships: StudentMembershipRow[]) =>
  (row: StudentWeekResultRow): PerformanceWeekDto => ({
    weekId: row.week.id,
    weekNumber: row.week.weekNumber,
    groupId: row.week.groupId,
    groupName: memberships.find(({ group }) => group.id === row.week.groupId)?.group.name ?? null,
    startDate: formatIsoDate(row.week.startDate),
    bonus: row.bonus,
    exam: row.exam,
    sum: row.sum,
    submittedAt: row.week.submittedAt === null ? null : row.week.submittedAt.toISOString(),
  });
