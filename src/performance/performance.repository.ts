import { Injectable } from '@nestjs/common';
import type { AttendanceMark, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { FINALIZED_WEEK_FILTER, RANKED_STUDENT_FILTER } from './performance';

/**
 * Итог студента за одну финализированную неделю вместе с её группой.
 *
 * Одной выборкой закрываются сразу три вопроса витрины: общий балл (среднее
 * по всем строкам), разрез по группам (те же строки, сгруппированные) и график
 * ТЗ 5.8 (строки по порядку). Три отдельных агрегата дали бы три запроса
 * и три возможности разойтись между собой.
 */
const WEEK_RESULT_SELECT = {
  sum: true,
  bonus: true,
  exam: true,
  week: {
    select: {
      id: true,
      weekNumber: true,
      startDate: true,
      submittedAt: true,
      groupId: true,
    },
  },
} satisfies Prisma.WeekResultSelect;

export type StudentWeekResultRow = Prisma.WeekResultGetPayload<{
  select: typeof WEEK_RESULT_SELECT;
}>;

/** Членство студента — группа попадает в разрез даже без единой закрытой недели. */
const MEMBERSHIP_SELECT = {
  status: true,
  group: {
    select: {
      id: true,
      name: true,
      course: { select: { id: true, title: true } },
      branch: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.GroupStudentSelect;

export type StudentMembershipRow = Prisma.GroupStudentGetPayload<{
  select: typeof MEMBERSHIP_SELECT;
}>;

/** Посещаемость студента по видам отметок (ТЗ 5.2: график Late/Absent). */
export interface AttendanceTally {
  attendance: AttendanceMark;
  count: number;
}

/** Средний балл одного студента, попавшего в рейтинг. */
export interface RankedAverage {
  studentId: string;
  /** Неокруглённое значение: сравнения мест идут по нему (см. `roundScore`). */
  average: number;
}

/**
 * Потолок выборки недель. «Все недели» не должно означать «сколько угодно»:
 * тот же приём, что у выгрузки состава группы (сессия 0013). Курс длится месяц
 * (ТЗ 5.6), поэтому 500 недель — это заведомо больше любой реальной истории.
 */
export const MAX_PERFORMANCE_WEEKS = 500;

/**
 * Доступ к данным успеваемости (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma; средние, категории и места
 * считает сервис чистыми функциями из `performance.ts`.
 */
@Injectable()
export class PerformanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Есть ли такой студент: успеваемость несуществующего — это 404, а не пустая витрина. */
  findStudent(id: string): Promise<{ id: string; firstName: string; lastName: string } | null> {
    return this.prisma.student.findUnique({
      where: { id },
      select: { id: true, firstName: true, lastName: true },
    });
  }

  /**
   * Итоги студента по **финализированным** неделям, от свежих к старым.
   * Открытые недели в общий балл не входят (решение сессии 0019).
   */
  findFinalizedResults(studentId: string): Promise<StudentWeekResultRow[]> {
    return this.prisma.weekResult.findMany({
      where: { studentId, week: FINALIZED_WEEK_FILTER },
      select: WEEK_RESULT_SELECT,
      orderBy: [{ week: { startDate: 'desc' } }, { week: { weekNumber: 'desc' } }],
      take: MAX_PERFORMANCE_WEEKS,
    });
  }

  /**
   * Все членства студента, включая закрытые: разрез по группам — это его
   * учебная история, и группа, из которой он ушёл, из неё не пропадает
   * (то же решение, что в кабинете студента, сессия 0017).
   */
  findMemberships(studentId: string): Promise<StudentMembershipRow[]> {
    return this.prisma.groupStudent.findMany({
      where: { studentId },
      select: MEMBERSHIP_SELECT,
      orderBy: { enrolledAt: 'desc' },
    });
  }

  /**
   * Посещаемость по видам отметок. Считается по **всем** отмеченным дням,
   * а не только по финализированным неделям: пропуск — это факт, отмеченный
   * в журнале, и он не становится «настоящим» при финализации. Баллы и коины
   * ждут закрытия недели, посещаемость — нет.
   *
   * Неотмеченные клетки (`attendance: null`) не считаются: «не отмечен»
   * и «отсутствовал» — разные состояния (решение сессии 0018).
   */
  async aggregateAttendance(studentId: string): Promise<AttendanceTally[]> {
    const groups = await this.prisma.journalEntry.groupBy({
      by: ['attendance'],
      where: { studentId, attendance: { not: null } },
      _count: { _all: true },
    });

    return groups.flatMap(({ attendance, _count }) =>
      attendance === null ? [] : [{ attendance, count: _count._all }],
    );
  }

  /**
   * Средний балл каждого студента, попавшего в рейтинг (ТЗ 5.13).
   *
   * Одной выборкой вместо трёх запросов («мой средний», «сколько выше меня»,
   * «сколько всего»): место, число участников и корона выводятся из неё
   * чистой арифметикой, и разойтись между собой они не могут. Строк здесь
   * столько, сколько в центре учащихся с закрытыми неделями.
   */
  async findRankedAverages(): Promise<RankedAverage[]> {
    const groups = await this.prisma.weekResult.groupBy({
      by: ['studentId'],
      where: { week: FINALIZED_WEEK_FILTER, student: RANKED_STUDENT_FILTER },
      _avg: { sum: true },
    });

    return groups.flatMap(({ studentId, _avg }) =>
      _avg.sum === null ? [] : [{ studentId, average: _avg.sum }],
    );
  }
}
