import { Injectable } from '@nestjs/common';
import type { AttendanceMark, LessonType, Prisma } from '@prisma/client';
import { CoinSource } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { DIRECTOR_POSITION_NAME } from '../rbac/rbac.constants';
import { JournalWeekSortField } from './dto';

/** Контакты руководителя — адресата отчёта о финализации недели (ТЗ 5.8, 0018). */
export interface DirectorContact {
  id: string;
  firstName: string;
  lastName: string;
  telegram: string | null;
  phone: string | null;
  email: string | null;
}

/**
 * Поля учебного дня, общие для списка и карточки. Ведущий и длительность
 * отдаются вместе с днём: из них считаются часы зарплаты (ТЗ 5.16), и экран,
 * который их проставляет, — это экран журнала.
 */
const DAY_SELECT = {
  id: true,
  date: true,
  type: true,
  durationMinutes: true,
  mentor: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.JournalDaySelect;

/** Неделя в списке журнала: дни есть, клеток нет — их не показывает список. */
const WEEK_SUMMARY_SELECT = {
  id: true,
  groupId: true,
  weekNumber: true,
  startDate: true,
  submittedAt: true,
  submittedBy: { select: { id: true, firstName: true, lastName: true } },
  days: { select: DAY_SELECT, orderBy: { date: 'asc' } },
} satisfies Prisma.JournalWeekSelect;

/** Неделя целиком: дни с клетками и ручные слагаемые итогов. */
const WEEK_DETAIL_SELECT = {
  ...WEEK_SUMMARY_SELECT,
  days: {
    select: {
      ...DAY_SELECT,
      entries: { select: { studentId: true, attendance: true, score: true } },
    },
    orderBy: { date: 'asc' },
  },
  results: { select: { studentId: true, bonus: true, exam: true, sum: true } },
} satisfies Prisma.JournalWeekSelect;

/** Студент в составе группы — профиль рисуется рядом со строкой журнала. */
const ROSTER_SELECT = {
  studentId: true,
  status: true,
  student: {
    select: { id: true, firstName: true, lastName: true, phone: true, photoUrl: true },
  },
} satisfies Prisma.GroupStudentSelect;

export type WeekSummaryRow = Prisma.JournalWeekGetPayload<{ select: typeof WEEK_SUMMARY_SELECT }>;
export type WeekDetailRow = Prisma.JournalWeekGetPayload<{ select: typeof WEEK_DETAIL_SELECT }>;
export type RosterRow = Prisma.GroupStudentGetPayload<{ select: typeof ROSTER_SELECT }>;
export type StudentProfile = Prisma.StudentGetPayload<{
  select: { id: true; firstName: true; lastName: true; phone: true; photoUrl: true };
}>;

/** Группа в том виде, в каком её проверяет журнал. */
export type JournalGroup = Prisma.GroupGetPayload<{ select: { id: true; name: true } }>;

/** Агрегат по итогам недели: «Average» из ТЗ 5.8 и число студентов с итогом. */
export interface WeekAggregate {
  weekId: string;
  studentsCount: number;
  averageSum: number | null;
}

export interface JournalListParams {
  groupId: string;
  submitted?: boolean;
  sort: JournalWeekSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

/**
 * Учебный день для записи. `mentorId` и `durationMinutes` — то, из чего
 * складываются часы зарплаты (ТЗ 5.16, решение 0032): `null` означает
 * «не записано», и это законное состояние, а не ноль.
 */
export interface WeekDayInput {
  date: Date;
  type: LessonType;
  mentorId: string | null;
  durationMinutes: number | null;
}

/**
 * Правка одной клетки. `undefined` — поле не трогать, `null` — снять отметку:
 * без первого проставление ДЗ стирало бы посещаемость, без второго ошибочную
 * отметку нельзя было бы убрать.
 */
export interface WeekEntryInput {
  date: Date;
  studentId: string;
  attendance?: AttendanceMark | null;
  score?: number | null;
}

/** Итог студента за неделю. `sum` приходит уже посчитанным — правило живёт в сервисе. */
export interface WeekResultInput {
  studentId: string;
  bonus: number;
  exam: number;
  sum: number;
}

export interface CreateWeekInput {
  groupId: string;
  weekNumber: number;
  startDate: Date;
  days: WeekDayInput[];
  /** Действующий состав группы: у каждого сразу заводится нулевой итог. */
  studentIds: string[];
}

export interface UpdateWeekInput {
  weekId: string;
  startDate?: Date;
  /** Полный набор дней; `undefined` — не трогать. */
  days?: WeekDayInput[];
  entries?: WeekEntryInput[];
  /** Пересчитанные итоги **всех** студентов недели, а не только затронутых. */
  results: WeekResultInput[];
}

export interface WeekCoinAward {
  studentId: string;
  amount: number;
  reason: string;
}

export interface SubmitWeekInput {
  weekId: string;
  submittedById: string | null;
  submittedAt: Date;
  results: WeekResultInput[];
  awards: WeekCoinAward[];
}

/**
 * Доступ к данным журнала (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma; итоги (`sum`) и суммы
 * коинов приходят посчитанными из сервиса.
 */
@Injectable()
export class GroupJournalRepository {
  constructor(private readonly prisma: PrismaService) {}

  findGroup(id: string): Promise<JournalGroup | null> {
    return this.prisma.group.findUnique({ where: { id }, select: { id: true, name: true } });
  }

  async findWeeks(params: JournalListParams): Promise<{ rows: WeekSummaryRow[]; total: number }> {
    const where: Prisma.JournalWeekWhereInput = {
      groupId: params.groupId,
      ...(params.submitted === undefined
        ? {}
        : { submittedAt: params.submitted ? { not: null } : null }),
    };

    // Ключ `orderBy` собирается ветвлением, а не из строки: вычисляемое поле
    // прошло бы типизацию Prisma и упало бы уже в БД.
    const orderBy: Prisma.JournalWeekOrderByWithRelationInput =
      params.sort === JournalWeekSortField.StartDate
        ? { startDate: params.order }
        : { weekNumber: params.order };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.journalWeek.findMany({
        where,
        select: WEEK_SUMMARY_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.journalWeek.count({ where }),
    ]);

    return { rows, total };
  }

  /**
   * Средний Sum и число студентов по каждой неделе страницы (ТЗ 5.8: «Average»).
   *
   * Отдельный агрегат, а не выборка всех итогов: у группы из ста человек
   * страница из двадцати недель означала бы две тысячи строк ради двух чисел
   * на строку списка.
   */
  async aggregateWeeks(weekIds: string[]): Promise<WeekAggregate[]> {
    if (weekIds.length === 0) return [];

    const groups = await this.prisma.weekResult.groupBy({
      by: ['weekId'],
      where: { weekId: { in: weekIds } },
      _count: { _all: true },
      _avg: { sum: true },
    });

    return groups.map((group) => ({
      weekId: group.weekId,
      studentsCount: group._count._all,
      averageSum: group._avg.sum,
    }));
  }

  /**
   * Неделя ищется вместе с группой из пути, а не по одному `id`: иначе адрес
   * `/groups/A/journal/weeks/{id}` открывал бы неделю группы B — вложенность
   * выглядела бы защитой, не будучи ею (то же правило, что у уроков курса).
   */
  findWeek(groupId: string, weekId: string): Promise<WeekDetailRow | null> {
    return this.prisma.journalWeek.findFirst({
      where: { id: weekId, groupId },
      select: WEEK_DETAIL_SELECT,
    });
  }

  /**
   * Менторы группы — из них выбирается ведущий учебного дня.
   *
   * То же правило, что у слота расписания (0011): иначе «менторы группы»
   * и «кто ведёт занятия» разошлись бы как два независимых списка, а по вторым
   * считается зарплата (ТЗ 5.16). Статус сотрудника здесь не проверяется:
   * занятие мог провести человек, которого позже вывели из штата, и запретить
   * это значило бы переписать прошлое.
   */
  async findGroupMentorIds(groupId: string): Promise<Set<string>> {
    const rows = await this.prisma.groupMentor.findMany({
      where: { groupId },
      select: { employeeId: true },
    });

    return new Set(rows.map((row) => row.employeeId));
  }

  /** Состав группы: и действующий, и закрытый — журнал показывает историю. */
  findRoster(groupId: string): Promise<RosterRow[]> {
    return this.prisma.groupStudent.findMany({
      where: { groupId },
      select: ROSTER_SELECT,
      orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
    });
  }

  /** Профили студентов, отметки которых остались в неделе после выхода из состава. */
  findStudents(ids: string[]): Promise<StudentProfile[]> {
    if (ids.length === 0) return Promise.resolve([]);

    return this.prisma.student.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true, phone: true, photoUrl: true },
    });
  }

  /** Номер следующей недели группы: недели нумеруются подряд, с единицы. */
  async nextWeekNumber(groupId: string): Promise<number> {
    const last = await this.prisma.journalWeek.findFirst({
      where: { groupId },
      orderBy: { weekNumber: 'desc' },
      select: { weekNumber: true },
    });

    return (last?.weekNumber ?? 0) + 1;
  }

  /**
   * Учебные дни группы, уже занятые другими неделями. Один календарный день
   * не может принадлежать двум неделям сразу: приход за него посчитался бы дважды.
   */
  findConflictingDays(
    groupId: string,
    dates: Date[],
    exceptWeekId?: string,
  ): Promise<{ date: Date; week: { weekNumber: number } }[]> {
    return this.prisma.journalDay.findMany({
      where: {
        date: { in: dates },
        week: {
          groupId,
          ...(exceptWeekId === undefined ? {} : { id: { not: exceptWeekId } }),
        },
      },
      select: { date: true, week: { select: { weekNumber: true } } },
    });
  }

  /**
   * Новая неделя одной транзакцией: сама неделя, её дни и нулевые итоги
   * действующего состава. Неделя без дней или без строк итогов — это половина
   * созданного, а не «почти созданное» (ТЗ 7).
   */
  async createWeek(input: CreateWeekInput): Promise<WeekDetailRow> {
    const week = await this.prisma.$transaction(async (tx) => {
      const created = await tx.journalWeek.create({
        data: {
          groupId: input.groupId,
          weekNumber: input.weekNumber,
          startDate: input.startDate,
          days: {
            create: input.days.map((day) => ({
              date: day.date,
              type: day.type,
              mentorId: day.mentorId,
              durationMinutes: day.durationMinutes,
            })),
          },
        },
        select: { id: true },
      });

      if (input.studentIds.length > 0) {
        await tx.weekResult.createMany({
          data: input.studentIds.map((studentId) => ({ weekId: created.id, studentId })),
        });
      }

      return created;
    });

    return this.requireWeek(week.id);
  }

  /**
   * Правка недели одной транзакцией: дни, клетки и пересчитанные итоги.
   *
   * Порядок важен: сначала набор дней, потом клетки (их день должен уже
   * существовать), потом итоги — они посчитаны сервисом по **итоговому**
   * состоянию недели.
   */
  async updateWeek(input: UpdateWeekInput): Promise<WeekDetailRow> {
    await this.prisma.$transaction(async (tx) => {
      if (input.startDate !== undefined) {
        await tx.journalWeek.update({
          where: { id: input.weekId },
          data: { startDate: input.startDate },
        });
      }

      if (input.days !== undefined) {
        // Убранный день уносит свои клетки каскадом: отметка за день, которого
        // в неделе нет, ничего не значит.
        await tx.journalDay.deleteMany({
          where: { weekId: input.weekId, date: { notIn: input.days.map((day) => day.date) } },
        });

        for (const day of input.days) {
          await tx.journalDay.upsert({
            where: { weekId_date: { weekId: input.weekId, date: day.date } },
            create: {
              weekId: input.weekId,
              date: day.date,
              type: day.type,
              mentorId: day.mentorId,
              durationMinutes: day.durationMinutes,
            },
            // Набор дней заменяется целиком (правило 0018), поэтому и ведущий
            // с длительностью записываются целиком: не переданные в теле
            // означают «снять», а не «оставить как было».
            update: {
              type: day.type,
              mentorId: day.mentorId,
              durationMinutes: day.durationMinutes,
            },
          });
        }
      }

      if (input.entries !== undefined && input.entries.length > 0) {
        const days = await tx.journalDay.findMany({
          where: { weekId: input.weekId },
          select: { id: true, date: true },
        });
        const dayIdByDate = new Map(days.map((day) => [day.date.getTime(), day.id]));

        for (const entry of input.entries) {
          const dayId = dayIdByDate.get(entry.date.getTime());
          // Сервис уже отверг клетки чужих дней — сюда такие не доходят.
          if (dayId === undefined) continue;

          await tx.journalEntry.upsert({
            where: { dayId_studentId: { dayId, studentId: entry.studentId } },
            create: {
              dayId,
              studentId: entry.studentId,
              attendance: entry.attendance ?? null,
              score: entry.score ?? null,
            },
            update: {
              ...(entry.attendance === undefined ? {} : { attendance: entry.attendance }),
              ...(entry.score === undefined ? {} : { score: entry.score }),
            },
          });
        }
      }

      await writeResults(tx, input.weekId, input.results);
    });

    return this.requireWeek(input.weekId);
  }

  /**
   * Финализация недели одной транзакцией (ТЗ 5.8: блокировка + автоначисление
   * коинов + отчёт Директору; ТЗ 7 — начисления транзакционны).
   *
   * Оборванная на середине финализация оставила бы либо заблокированную неделю
   * без коинов, либо коины по неделе, которую ещё можно переписать.
   */
  async submitWeek(input: SubmitWeekInput): Promise<WeekDetailRow> {
    await this.prisma.$transaction(async (tx) => {
      await writeResults(tx, input.weekId, input.results);

      for (const award of input.awards) {
        await tx.coinTransaction.create({
          data: {
            studentId: award.studentId,
            amount: award.amount,
            reason: award.reason,
            source: CoinSource.WEEK_RESULT,
            weekId: input.weekId,
          },
        });

        await tx.coinBalance.upsert({
          where: { studentId: award.studentId },
          create: { studentId: award.studentId, balance: award.amount },
          update: { balance: { increment: award.amount } },
        });
      }

      await tx.journalWeek.update({
        where: { id: input.weekId },
        data: { submittedAt: input.submittedAt, submittedById: input.submittedById },
      });
    });

    return this.requireWeek(input.weekId);
  }

  async deleteWeek(weekId: string): Promise<void> {
    await this.prisma.journalWeek.delete({ where: { id: weekId } });
  }

  /** Профиль сотрудника по его аккаунту — тот, кто финализировал неделю. */
  findEmployeeByAccount(accountId: string): Promise<{ id: string } | null> {
    return this.prisma.employee.findUnique({ where: { accountId }, select: { id: true } });
  }

  /**
   * Действующие руководители — адресаты отчёта о финализации недели (ТЗ 5.8,
   * обещание 0018: «доставка появится с уведомлениями Фазы 11»).
   *
   * Директор определён **системной** позицией (`isSystem` + имя), а не просто
   * названием: несистемную позицию-тёзку правило не защищает — тот же довод,
   * что в правиле «последний Director» (0006). Контакты берутся снимком, адрес
   * под канал выбирает сервис (`addressFor`).
   */
  findActiveDirectors(): Promise<DirectorContact[]> {
    return this.prisma.employee.findMany({
      where: {
        status: 'ACTIVE',
        positions: { some: { position: { isSystem: true, name: DIRECTOR_POSITION_NAME } } },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        telegram: true,
        phone: true,
        email: true,
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    });
  }

  /** Неделя после записи: она только что существовала, отсутствие здесь — сбой. */
  private async requireWeek(weekId: string): Promise<WeekDetailRow> {
    return this.prisma.journalWeek.findUniqueOrThrow({
      where: { id: weekId },
      select: WEEK_DETAIL_SELECT,
    });
  }
}

/**
 * Итоги недели: строка заводится и на тех, у кого ещё нет ни одной отметки, —
 * «студент недели с нулём» и «студента в неделе нет» это разные вещи, и вторая
 * ломала бы средний балл (ТЗ 5.8).
 */
async function writeResults(
  tx: Prisma.TransactionClient,
  weekId: string,
  results: WeekResultInput[],
): Promise<void> {
  for (const result of results) {
    await tx.weekResult.upsert({
      where: { weekId_studentId: { weekId, studentId: result.studentId } },
      create: {
        weekId,
        studentId: result.studentId,
        bonus: result.bonus,
        exam: result.exam,
        sum: result.sum,
      },
      update: { bonus: result.bonus, exam: result.exam, sum: result.sum },
    });
  }
}
