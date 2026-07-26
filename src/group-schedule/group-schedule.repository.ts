import { Injectable } from '@nestjs/common';
import type { Prisma, WeekDay } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { ScheduleSlotSortField } from './dto';

const SCHEDULE_SLOT_SELECT = {
  id: true,
  groupId: true,
  dayOfWeek: true,
  startMinute: true,
  endMinute: true,
  createdAt: true,
  // Аудитория и ментор отдаются вместе со слотом: календарю (ТЗ 5.10) нужны
  // их названия, а не идентификаторы, и догружать их построчно он не должен.
  room: { select: { id: true, name: true } },
  mentor: { select: { id: true, firstName: true, lastName: true, middleName: true } },
} satisfies Prisma.ScheduleSlotSelect;

export type ScheduleSlotRow = Prisma.ScheduleSlotGetPayload<{
  select: typeof SCHEDULE_SLOT_SELECT;
}>;

/** Группа в том виде, в каком её проверяет сервис: филиал и сроки нужны правилам. */
const SLOT_GROUP_SELECT = {
  id: true,
  name: true,
  branchId: true,
  status: true,
  startDate: true,
  endDate: true,
} satisfies Prisma.GroupSelect;

export type SlotGroup = Prisma.GroupGetPayload<{ select: typeof SLOT_GROUP_SELECT }>;

/**
 * Занятие, попавшее в окно проверки пересечений: сам слот плюс группа, которой
 * он принадлежит. Решает сервис — здесь только выборка кандидатов.
 */
const SLOT_CONFLICT_SELECT = {
  id: true,
  groupId: true,
  dayOfWeek: true,
  startMinute: true,
  endMinute: true,
  roomId: true,
  mentorId: true,
  group: { select: SLOT_GROUP_SELECT },
} satisfies Prisma.ScheduleSlotSelect;

export type SlotConflictRow = Prisma.ScheduleSlotGetPayload<{
  select: typeof SLOT_CONFLICT_SELECT;
}>;

export interface ScheduleSlotListParams {
  groupId: string;
  search?: string;
  dayOfWeek?: WeekDay;
  roomId?: string;
  mentorId?: string;
  sort: ScheduleSlotSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface ScheduleSlotWriteInput {
  groupId: string;
  dayOfWeek: WeekDay;
  startMinute: number;
  endMinute: number;
  roomId: string | null;
  mentorId: string | null;
}

/** `undefined` — колонку не менять; значение (включая `null`) — записать. */
export type ScheduleSlotUpdateInput = Partial<Omit<ScheduleSlotWriteInput, 'groupId'>>;

/** Что ищем среди пересекающихся занятий: свои, той же аудитории, того же ментора. */
export interface OverlapParams {
  dayOfWeek: WeekDay;
  startMinute: number;
  endMinute: number;
  /** Правящийся слот сам с собой не конфликтует. */
  exceptSlotId?: string;
  groupId: string;
  roomId?: string;
  mentorId?: string;
}

/**
 * Доступ к данным расписания (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class GroupScheduleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(
    params: ScheduleSlotListParams,
  ): Promise<{ rows: ScheduleSlotRow[]; total: number }> {
    const where: Prisma.ScheduleSlotWhereInput = {
      groupId: params.groupId,
      ...(params.dayOfWeek === undefined ? {} : { dayOfWeek: params.dayOfWeek }),
      ...(params.roomId === undefined ? {} : { roomId: params.roomId }),
      ...(params.mentorId === undefined ? {} : { mentorId: params.mentorId }),
      ...(params.search === undefined
        ? {}
        : {
            OR: [
              { room: { name: { contains: params.search, mode: 'insensitive' } } },
              { mentor: { firstName: { contains: params.search, mode: 'insensitive' } } },
              { mentor: { lastName: { contains: params.search, mode: 'insensitive' } } },
            ],
          }),
    };

    // Ключ `orderBy` собирается ветвлением, а не из строки: вычисляемое поле
    // прошло бы типизацию Prisma и упало бы уже в БД.
    //
    // Порядок дней недели даёт сам тип в PostgreSQL: он сортируется в порядке
    // объявления значений, а объявлены они с понедельника.
    const orderBy: Prisma.ScheduleSlotOrderByWithRelationInput[] =
      params.sort === ScheduleSlotSortField.DayOfWeek
        ? [{ dayOfWeek: params.order }, { startMinute: params.order }]
        : params.sort === ScheduleSlotSortField.StartTime
          ? [{ startMinute: params.order }, { dayOfWeek: params.order }]
          : [{ createdAt: params.order }];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.scheduleSlot.findMany({
        where,
        select: SCHEDULE_SLOT_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.scheduleSlot.count({ where }),
    ]);

    return { rows, total };
  }

  findGroup(id: string): Promise<SlotGroup | null> {
    return this.prisma.group.findUnique({ where: { id }, select: SLOT_GROUP_SELECT });
  }

  findRoom(id: string): Promise<{ id: string; name: string; branchId: string } | null> {
    return this.prisma.room.findUnique({
      where: { id },
      select: { id: true, name: true, branchId: true },
    });
  }

  /**
   * Ментор ищется среди менторов **этой группы**: посторонний сотрудник
   * в расписании группы не появляется, даже если он существует.
   */
  findGroupMentor(
    groupId: string,
    employeeId: string,
  ): Promise<{ employee: { id: string; firstName: string; lastName: string } } | null> {
    return this.prisma.groupMentor.findUnique({
      where: { groupId_employeeId: { groupId, employeeId } },
      select: { employee: { select: { id: true, firstName: true, lastName: true } } },
    });
  }

  /** Слот вместе с группой из пути: `/groups/A/schedule/{id}` не отдаёт занятие группы B. */
  findOne(groupId: string, slotId: string): Promise<ScheduleSlotRow | null> {
    return this.prisma.scheduleSlot.findFirst({
      where: { id: slotId, groupId },
      select: SCHEDULE_SLOT_SELECT,
    });
  }

  /**
   * Занятия того же дня недели, пересекающиеся по времени с заданным окном
   * и относящиеся к этой группе, этой аудитории или этому ментору.
   *
   * Пересечение отрезков: начало кандидата раньше конца окна, а конец —
   * позже начала окна. Занятия «встык» (12:00–14:00 после 10:00–12:00)
   * не пересекаются.
   */
  findOverlapping(params: OverlapParams): Promise<SlotConflictRow[]> {
    const targets: Prisma.ScheduleSlotWhereInput[] = [{ groupId: params.groupId }];
    if (params.roomId !== undefined) targets.push({ roomId: params.roomId });
    if (params.mentorId !== undefined) targets.push({ mentorId: params.mentorId });

    return this.prisma.scheduleSlot.findMany({
      where: {
        ...(params.exceptSlotId === undefined ? {} : { id: { not: params.exceptSlotId } }),
        dayOfWeek: params.dayOfWeek,
        startMinute: { lt: params.endMinute },
        endMinute: { gt: params.startMinute },
        OR: targets,
      },
      select: SLOT_CONFLICT_SELECT,
    });
  }

  create(input: ScheduleSlotWriteInput): Promise<ScheduleSlotRow> {
    return this.prisma.scheduleSlot.create({ data: input, select: SCHEDULE_SLOT_SELECT });
  }

  update(id: string, input: ScheduleSlotUpdateInput): Promise<ScheduleSlotRow> {
    // `undefined` Prisma пропускает: не переданное поле остаётся прежним.
    return this.prisma.scheduleSlot.update({
      where: { id },
      data: input,
      select: SCHEDULE_SLOT_SELECT,
    });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.scheduleSlot.delete({ where: { id } });
  }
}
