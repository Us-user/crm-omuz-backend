import { Injectable } from '@nestjs/common';
import type { GroupFormat, Prisma, WeekDay } from '@prisma/client';
import { GroupStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Слот вместе со всем, что рисует ячейка календаря (ТЗ 5.10: «группа, время,
 * Type, аудитория, ментор»).
 *
 * Курс и филиал берутся у группы: календарь читают целиком, и догрузка каждого
 * названия по строке превратила бы одно окно в сотню запросов. Сроки и статус
 * группы едут сюда же — по ним сервис решает, идут ли занятия в конкретную дату
 * (`runsOn`), и второй запрос за ними был бы запросом за тем, что уже прочитано.
 */
const TIMETABLE_SLOT_SELECT = {
  id: true,
  dayOfWeek: true,
  startMinute: true,
  endMinute: true,
  group: {
    select: {
      id: true,
      name: true,
      format: true,
      status: true,
      startDate: true,
      endDate: true,
      course: { select: { id: true, title: true } },
      branch: { select: { id: true, name: true } },
    },
  },
  room: { select: { id: true, name: true } },
  mentor: { select: { id: true, firstName: true, lastName: true, middleName: true } },
} satisfies Prisma.ScheduleSlotSelect;

export type TimetableSlotRow = Prisma.ScheduleSlotGetPayload<{
  select: typeof TIMETABLE_SLOT_SELECT;
}>;

/** Учебный день журнала: дата, тип занятия и группа, которой он принадлежит. */
const TIMETABLE_JOURNAL_SELECT = {
  date: true,
  type: true,
  week: { select: { groupId: true } },
} satisfies Prisma.JournalDaySelect;

export type TimetableJournalRow = Prisma.JournalDayGetPayload<{
  select: typeof TIMETABLE_JOURNAL_SELECT;
}>;

export interface TimetableSlotParams {
  /** Границы окна, обе включительно: по ним отбираются группы, чьи сроки его накрывают. */
  from: Date;
  to: Date;
  /**
   * Дни недели, встречающиеся в окне. У окна короче недели их меньше семи,
   * и тогда условие сужает выборку; для месяца оно бессмысленно и не ставится.
   */
  weekDays?: WeekDay[];
  groupId?: string;
  courseId?: string;
  branchId?: string;
  roomId?: string;
  mentorId?: string;
  format?: GroupFormat;
}

export interface TimetableJournalParams {
  from: Date;
  to: Date;
  groupIds: string[];
}

/**
 * Доступ к данным общего расписания (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class TimetableRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Слоты-кандидаты окна.
   *
   * Отбор **сужает**, но не решает: группы отбираются по пересечению их сроков
   * с окном (незаполненная граница — открытая), а попадает ли занятие в каждую
   * конкретную дату, считает сервис (`runsOn`). Иначе правило предметной области
   * уехало бы в слой данных, а условие «дата, у которой день недели совпадает
   * с днём слота» в Prisma всё равно не выражается. Тот же ход, что с поиском
   * пересечений расписания (сессия 0011).
   */
  findSlots(params: TimetableSlotParams): Promise<TimetableSlotRow[]> {
    const group: Prisma.GroupWhereInput = {
      // Отменённая группа не проводила занятий вообще (0008): ни в будущем,
      // ни в прошлом. Завершённая, наоборот, остаётся — её занятия были,
      // и прошлый месяц обязан их показать; ограничивают их сроки группы.
      status: { not: GroupStatus.CANCELLED },
      ...(params.courseId === undefined ? {} : { courseId: params.courseId }),
      ...(params.branchId === undefined ? {} : { branchId: params.branchId }),
      ...(params.format === undefined ? {} : { format: params.format }),
      AND: [
        { OR: [{ startDate: null }, { startDate: { lte: params.to } }] },
        { OR: [{ endDate: null }, { endDate: { gte: params.from } }] },
      ],
    };

    return this.prisma.scheduleSlot.findMany({
      where: {
        ...(params.groupId === undefined ? {} : { groupId: params.groupId }),
        ...(params.roomId === undefined ? {} : { roomId: params.roomId }),
        ...(params.mentorId === undefined ? {} : { mentorId: params.mentorId }),
        ...(params.weekDays === undefined ? {} : { dayOfWeek: { in: params.weekDays } }),
        group,
      },
      select: TIMETABLE_SLOT_SELECT,
      // Порядок внутри дня календарь всё равно задаёт сам (`expandTimetable`),
      // но устойчивая выдача упрощает разбор запроса и не стоит ничего.
      orderBy: [{ startMinute: 'asc' }, { dayOfWeek: 'asc' }],
    });
  }

  /**
   * Учебные дни журнала окна — источник колонки «Type» и признака «проведено».
   *
   * Отбираются только группы, чьи слоты уже попали в окно: спрашивать журнал
   * обо всём центре значило бы читать дни групп, которых в календаре нет.
   */
  findJournalDays(params: TimetableJournalParams): Promise<TimetableJournalRow[]> {
    return this.prisma.journalDay.findMany({
      where: {
        date: { gte: params.from, lte: params.to },
        week: { groupId: { in: params.groupIds } },
      },
      select: TIMETABLE_JOURNAL_SELECT,
    });
  }
}
