import { Injectable } from '@nestjs/common';
import type { DurationUnit, GroupFormat, GroupStatus, Prisma } from '@prisma/client';
import { GroupStudentStatus } from '@prisma/client';

import type { SortOrder } from '../common';
// Прямым путём, а не через barrel `../performance`: оттуда пришли бы ещё сервис
// и репозиторий успеваемости, которые группам не нужны (правило сессии 0007).
import { FINALIZED_WEEK_FILTER } from '../performance/performance';
import { PrismaService } from '../prisma/prisma.service';
import { GroupSortField } from './dto';

const GROUP_SELECT = {
  id: true,
  name: true,
  description: true,
  format: true,
  startDate: true,
  endDate: true,
  durationValue: true,
  durationUnit: true,
  capacity: true,
  status: true,
  telegramUrl: true,
  createdAt: true,
  // Курс и филиал отдаются вместе с группой: список из одних идентификаторов
  // заставил бы экран догружать названия по каждой строке.
  // `isLastCourse` здесь не для красоты — по нему видно, какая группа
  // при завершении запустит автовыпуск (ТЗ 5.11).
  course: { select: { id: true, title: true, isLastCourse: true } },
  branch: { select: { id: true, name: true } },
  // «Набрано» из «Required students = набрано/вместимость» (ТЗ 5.5). Считаются
  // только действующие членства: покинувший курс в наборе группы не стоит.
  _count: { select: { students: { where: { status: GroupStudentStatus.ACTIVE } } } },
} satisfies Prisma.GroupSelect;

export type GroupRow = Prisma.GroupGetPayload<{ select: typeof GROUP_SELECT }>;

export interface GroupListParams {
  search?: string;
  branchId?: string;
  courseId?: string;
  status?: GroupStatus;
  format?: GroupFormat;
  sort: GroupSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface GroupWriteInput {
  name: string;
  description: string | null;
  courseId: string;
  branchId: string;
  format?: GroupFormat;
  startDate: Date | null;
  endDate: Date | null;
  durationValue: number | null;
  durationUnit?: DurationUnit;
  capacity: number | null;
  status?: GroupStatus;
  telegramUrl: string | null;
}

/** `undefined` — колонку не менять; значение (включая `null`) — записать. */
export type GroupUpdateInput = Partial<GroupWriteInput>;

/** Кто сейчас в составе группы — счётчики считаются по действующим членствам. */
export interface GroupMemberRow {
  groupId: string;
  studentId: string;
}

/** Итог студента за одну закрытую неделю **этой** группы. */
export interface GroupWeekResultRow {
  groupId: string;
  studentId: string;
  sum: number;
}

/**
 * Сырьё для счётчиков категорий (ТЗ 5.5): состав и итоги закрытых недель.
 * Средние, категории и счётчики считает сервис — здесь только выборка.
 */
export interface GroupActivityRows {
  members: GroupMemberRow[];
  results: GroupWeekResultRow[];
}

/**
 * Доступ к данным групп (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class GroupsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: GroupListParams): Promise<{ rows: GroupRow[]; total: number }> {
    const where: Prisma.GroupWhereInput = {
      ...(params.branchId === undefined ? {} : { branchId: params.branchId }),
      ...(params.courseId === undefined ? {} : { courseId: params.courseId }),
      ...(params.status === undefined ? {} : { status: params.status }),
      ...(params.format === undefined ? {} : { format: params.format }),
      ...(params.search === undefined
        ? {}
        : {
            OR: [
              { name: { contains: params.search, mode: 'insensitive' } },
              { description: { contains: params.search, mode: 'insensitive' } },
              { course: { title: { contains: params.search, mode: 'insensitive' } } },
              { branch: { name: { contains: params.search, mode: 'insensitive' } } },
            ],
          }),
    };

    // Ключ `orderBy` собирается ветвлением, а не из строки: вычисляемое поле
    // прошло бы типизацию Prisma и упало бы уже в БД.
    const orderBy: Prisma.GroupOrderByWithRelationInput =
      params.sort === GroupSortField.Name
        ? { name: params.order }
        : params.sort === GroupSortField.StartDate
          ? // Группа без назначенной даты начала уезжает в конец при любом
            // направлении: «не назначено» — не «раньше всех».
            { startDate: { sort: params.order, nulls: 'last' } }
          : { createdAt: params.order };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.group.findMany({
        where,
        select: GROUP_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.group.count({ where }),
    ]);

    return { rows, total };
  }

  findById(id: string): Promise<GroupRow | null> {
    return this.prisma.group.findUnique({ where: { id }, select: GROUP_SELECT });
  }

  /**
   * Состав и итоги закрытых недель для счётчиков категорий активности (ТЗ 5.5).
   *
   * Балл считается **в разрезе группы**, а не глобальный (решение сессии 0019):
   * счётчики стоят на карточке группы, и сдвигаться от учёбы человека
   * на соседнем курсе они не должны.
   *
   * Две выборки вместо агрегата: `WeekResult` не хранит группу (она у недели),
   * а `groupBy` Prisma умеет группировать только по своим колонкам — по одному
   * запросу на группу вышло бы столько же запросов, сколько строк на странице.
   * Итоги сводятся в средние уже в сервисе. Объём ограничен страницей списка
   * (`limit` ≤ 100) и длиной журнала её групп; на масштабе учебного центра
   * это тысячи коротких строк.
   */
  async findActivity(groupIds: string[]): Promise<GroupActivityRows> {
    if (groupIds.length === 0) return { members: [], results: [] };

    const [members, results] = await this.prisma.$transaction([
      this.prisma.groupStudent.findMany({
        where: { groupId: { in: groupIds }, status: GroupStudentStatus.ACTIVE },
        select: { groupId: true, studentId: true },
      }),
      this.prisma.weekResult.findMany({
        where: { week: { groupId: { in: groupIds }, ...FINALIZED_WEEK_FILTER } },
        select: { studentId: true, sum: true, week: { select: { groupId: true } } },
      }),
    ]);

    return {
      members,
      results: results.map(({ studentId, sum, week }) => ({
        groupId: week.groupId,
        studentId,
        sum,
      })),
    };
  }

  /**
   * Тёзка внутри филиала, без учёта регистра. Составной уникальный индекс
   * регистр учитывает, а «Frontend-1» и «frontend-1» человек читает как одну группу.
   */
  findByName(branchId: string, name: string): Promise<{ id: string; name: string } | null> {
    return this.prisma.group.findFirst({
      where: { branchId, name: { equals: name, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
  }

  findBranch(id: string): Promise<{ id: string; name: string } | null> {
    return this.prisma.branch.findUnique({ where: { id }, select: { id: true, name: true } });
  }

  findCourse(id: string): Promise<{ id: string; title: string } | null> {
    return this.prisma.course.findUnique({ where: { id }, select: { id: true, title: true } });
  }

  /**
   * Сколько занятий группы стоит в аудиториях (ТЗ 5.5, расписание).
   * Нужно переносу в другой филиал: аудитория обязана быть в филиале группы.
   */
  countScheduleSlotsWithRoom(groupId: string): Promise<number> {
    return this.prisma.scheduleSlot.count({ where: { groupId, roomId: { not: null } } });
  }

  /**
   * Сколько всего членств у группы — действующих и закрытых (ТЗ 5.5).
   * Нужно удалению: закрытая строка это учебная история студента, и уносить
   * её каскадом вместе с группой нельзя.
   */
  countStudents(groupId: string): Promise<number> {
    return this.prisma.groupStudent.count({ where: { groupId } });
  }

  create(input: GroupWriteInput): Promise<GroupRow> {
    return this.prisma.group.create({ data: input, select: GROUP_SELECT });
  }

  update(id: string, input: GroupUpdateInput): Promise<GroupRow> {
    // `undefined` Prisma пропускает: не переданное поле остаётся прежним.
    return this.prisma.group.update({ where: { id }, data: input, select: GROUP_SELECT });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.group.delete({ where: { id } });
  }
}
