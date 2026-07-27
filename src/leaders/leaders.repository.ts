import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { FINALIZED_WEEK_FILTER, RANKED_STUDENT_FILTER } from '../performance/performance';
import type { ScoredStudent } from './leaders';

/**
 * Действующее членство в том виде, в каком его требует рейтинг: условие взято
 * из общей константы, а не переписано рядом. Три места, считающие рейтинг
 * по разным наборам студентов, разошлись бы молча (решение сессии 0019).
 */
const RANKED_MEMBERSHIP = RANKED_STUDENT_FILTER.groups.some;

/** Профиль участника рейтинга вместе с его действующими группами. */
const LEADER_STUDENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  photoUrl: true,
  groups: {
    where: RANKED_MEMBERSHIP,
    select: {
      group: {
        select: { id: true, name: true, course: { select: { id: true, title: true } } },
      },
    },
    orderBy: { group: { name: 'asc' } },
  },
} satisfies Prisma.StudentSelect;

export type LeaderStudentRow = Prisma.StudentGetPayload<{ select: typeof LEADER_STUDENT_SELECT }>;

/** Строка снимка месяца вместе с профилем победителя и тем, кто месяц закрыл. */
const WINNER_SELECT = {
  id: true,
  month: true,
  place: true,
  averageScore: true,
  weeksCount: true,
  createdAt: true,
  student: { select: { id: true, firstName: true, lastName: true, photoUrl: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.MonthlyWinnerSelect;

export type MonthlyWinnerRow = Prisma.MonthlyWinnerGetPayload<{ select: typeof WINNER_SELECT }>;

/** Срез рейтинга: весь центр либо одна группа/курс (ТЗ 5.13: «фильтр по группе/курсу»). */
export interface LeadersScope {
  groupId?: string;
  courseId?: string;
}

/** Строка снимка перед записью — балл уже округлён до показанного значения. */
export interface MonthlyWinnerInput {
  studentId: string;
  place: number;
  averageScore: number;
  weeksCount: number;
}

/**
 * Доступ к данным рейтинга (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — места, корону и срез победителей считает сервис
 * чистыми функциями из `leaders.ts`.
 */
@Injectable()
export class LeadersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Средний балл каждого участника рейтинга (ТЗ 5.13).
   *
   * Выборка **не постраничная и без потолка** — намеренно, как в сессии 0019:
   * место считается как «сколько строго выше», то есть требует всего списка,
   * а усечение дало бы тихо неверные номера. Строк здесь столько, сколько
   * в центре учащихся с закрытыми неделями.
   *
   * Срез по группе или курсу сужает **обе** стороны: и недели, по которым
   * считается балл, и состав участников. Считать внутри группы по общему баллу
   * значило бы сравнивать её студентов числом, в которое входит учёба
   * на соседнем курсе, — и разойтись со счётчиками карточки группы (ТЗ 5.5).
   */
  async findScores(scope: LeadersScope): Promise<ScoredStudent[]> {
    const groups = await this.prisma.weekResult.groupBy({
      by: ['studentId'],
      where: {
        week: { ...FINALIZED_WEEK_FILTER, ...weekScopeOf(scope) },
        student: { groups: { some: { ...RANKED_MEMBERSHIP, ...membershipScopeOf(scope) } } },
      },
      _avg: { sum: true },
      _count: { _all: true },
    });

    return toScores(groups);
  }

  /**
   * Средний балл каждого студента по финализированным неделям **месяца**
   * (ТЗ 5.13: победители месяца).
   *
   * Неделя относится к месяцу своей даты начала: отрезок задаётся правой
   * невключающей границей, чтобы не выводить самому, сколько в месяце дней.
   *
   * Фильтра «учится сейчас» здесь **нет**, в отличие от живого рейтинга:
   * снимок описывает, кто учился лучше всех **тогда**, и отбор по сегодняшнему
   * статусу вычеркнул бы из июня того, кто закончил курс в июле, — то есть
   * переписал бы прошлое, против чего снимок и заводится.
   */
  async findMonthScores(monthStart: Date, nextMonth: Date): Promise<ScoredStudent[]> {
    const groups = await this.prisma.weekResult.groupBy({
      by: ['studentId'],
      where: {
        week: { ...FINALIZED_WEEK_FILTER, startDate: { gte: monthStart, lt: nextMonth } },
      },
      _avg: { sum: true },
      _count: { _all: true },
    });

    return toScores(groups);
  }

  /** Профили строк текущей страницы: один запрос на страницу, а не на строку. */
  findStudents(ids: string[]): Promise<LeaderStudentRow[]> {
    if (ids.length === 0) return Promise.resolve([]);

    return this.prisma.student.findMany({
      where: { id: { in: ids } },
      select: LEADER_STUDENT_SELECT,
    });
  }

  /** Снимок месяца целиком: он один экран, страницами его не режут. */
  findWinners(month: Date): Promise<MonthlyWinnerRow[]> {
    return this.prisma.monthlyWinner.findMany({
      where: { month },
      select: WINNER_SELECT,
      orderBy: [{ place: 'asc' }, { averageScore: 'desc' }],
    });
  }

  /** Последний закрытый месяц — «Winners of the last month» без параметра. */
  async findLatestClosedMonth(): Promise<Date | null> {
    const latest = await this.prisma.monthlyWinner.findFirst({
      orderBy: { month: 'desc' },
      select: { month: true },
    });

    return latest?.month ?? null;
  }

  /** Закрыт ли месяц: на этом держится запрет повторного закрытия (409). */
  countWinners(month: Date): Promise<number> {
    return this.prisma.monthlyWinner.count({ where: { month } });
  }

  /**
   * Запись снимка одной транзакцией: месяц закрывается целиком либо не
   * закрывается вовсе (ТЗ 7). Половина снимка — это неверный список
   * победителей, который выглядит настоящим.
   */
  createWinners(
    month: Date,
    winners: MonthlyWinnerInput[],
    createdById: string | null,
  ): Promise<MonthlyWinnerRow[]> {
    return this.prisma.$transaction(async (tx) => {
      await tx.monthlyWinner.createMany({
        data: winners.map((winner) => ({ ...winner, month, createdById })),
      });

      return tx.monthlyWinner.findMany({
        where: { month },
        select: WINNER_SELECT,
        orderBy: [{ place: 'asc' }, { averageScore: 'desc' }],
      });
    });
  }

  async deleteWinners(month: Date): Promise<number> {
    const { count } = await this.prisma.monthlyWinner.deleteMany({ where: { month } });

    return count;
  }

  /** Профиль вызывающего — им подписывается закрытый месяц. `null` без профиля. */
  findEmployeeByAccount(accountId: string): Promise<{ id: string } | null> {
    return this.prisma.employee.findUnique({ where: { accountId }, select: { id: true } });
  }
}

/** Недели среза: сам балл считается только по ним. */
const weekScopeOf = (scope: LeadersScope): Prisma.JournalWeekWhereInput => ({
  ...(scope.groupId === undefined ? {} : { groupId: scope.groupId }),
  ...(scope.courseId === undefined ? {} : { group: { courseId: scope.courseId } }),
});

/** Состав среза: кто вообще участвует в этом рейтинге. */
const membershipScopeOf = (scope: LeadersScope): Prisma.GroupStudentWhereInput => ({
  ...(scope.groupId === undefined ? {} : { groupId: scope.groupId }),
  ...(scope.courseId === undefined ? {} : { group: { courseId: scope.courseId } }),
});

/**
 * `_avg.sum` — среднее по неделям, `_count._all` — сколько их было.
 * Студент без единой недели в выборку не попадает вовсе, поэтому `null`
 * в среднем означал бы поломку агрегата, а не отсутствие баллов.
 */
const toScores = (
  groups: { studentId: string; _avg: { sum: number | null }; _count: { _all: number } }[],
): ScoredStudent[] =>
  groups.flatMap(({ studentId, _avg, _count }) =>
    _avg.sum === null ? [] : [{ studentId, average: _avg.sum, weeksCount: _count._all }],
  );
