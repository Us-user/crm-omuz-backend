import { Injectable } from '@nestjs/common';
import type { DirectoryStatus, Prisma } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { MentorLevelSortField } from './dto';

const LEVEL_SELECT = {
  id: true,
  name: true,
  description: true,
  hourlyRate: true,
  status: true,
  createdAt: true,
  // Сколько месяцев ступень кому-то проставлена. Счётчик, а не сами записи:
  // на экране справочника нужно только число, а месяцев за годы много.
  // На нём же держится запрет удалять уровень, по которому считали зарплату.
  _count: { select: { history: true } },
} satisfies Prisma.MentorLevelSelect;

export type MentorLevelRow = Prisma.MentorLevelGetPayload<{ select: typeof LEVEL_SELECT }>;

/**
 * Строка истории отдаётся вместе со ступенью: экран «уровень ментора по месяцам»
 * показывает ставку рядом с месяцем, и вторым запросом за справочником
 * он не должен ходить.
 */
const HISTORY_SELECT = {
  id: true,
  employeeId: true,
  month: true,
  createdAt: true,
  level: { select: { id: true, name: true, hourlyRate: true, status: true } },
} satisfies Prisma.MentorLevelHistorySelect;

export type MentorLevelHistoryRow = Prisma.MentorLevelHistoryGetPayload<{
  select: typeof HISTORY_SELECT;
}>;

/** Ступень в том виде, в каком её проверяет простановка уровня. */
export interface LevelCandidate {
  id: string;
  name: string;
  status: DirectoryStatus;
}

export interface MentorLevelListParams {
  search?: string;
  status?: DirectoryStatus;
  sort: MentorLevelSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface MentorLevelWriteInput {
  name: string;
  description: string | null;
  hourlyRate: number;
  status?: DirectoryStatus;
}

/** `undefined` — колонку не менять; значение (включая `null`) — записать. */
export type MentorLevelUpdateInput = Partial<MentorLevelWriteInput>;

export interface MentorLevelHistoryListParams {
  employeeId: string;
  from?: Date;
  to?: Date;
  levelId?: string;
  order: SortOrder;
  skip: number;
  take: number;
}

/**
 * Доступ к данным уровней ментора (`Controller → Service → Repository`):
 * справочник ступеней и помесячная история сотрудников.
 *
 * Один репозиторий на обе таблицы, а не два: правила модуля связывают их между
 * собой (простановка уровня смотрит в справочник, а удаление ступени — в историю),
 * и разделение заставило бы e2e держать в согласии два хранилища ради одного
 * набора правил. Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class MentorLevelsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ──────────────────────── Справочник ступеней (ТЗ 5.14) ────────────────────

  async findMany(
    params: MentorLevelListParams,
  ): Promise<{ rows: MentorLevelRow[]; total: number }> {
    const where: Prisma.MentorLevelWhereInput = {
      ...(params.status === undefined ? {} : { status: params.status }),
      ...(params.search === undefined
        ? {}
        : {
            OR: [
              { name: { contains: params.search, mode: 'insensitive' } },
              { description: { contains: params.search, mode: 'insensitive' } },
            ],
          }),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.mentorLevel.findMany({
        where,
        select: LEVEL_SELECT,
        orderBy: orderByOf(params.sort, params.order),
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.mentorLevel.count({ where }),
    ]);

    return { rows, total };
  }

  findById(id: string): Promise<MentorLevelRow | null> {
    return this.prisma.mentorLevel.findUnique({ where: { id }, select: LEVEL_SELECT });
  }

  /** Тёзка без учёта регистра: «Senior mentor» и «senior mentor» — одна ступень. */
  findByName(name: string): Promise<{ id: string; name: string } | null> {
    return this.prisma.mentorLevel.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
  }

  create(input: MentorLevelWriteInput): Promise<MentorLevelRow> {
    return this.prisma.mentorLevel.create({ data: input, select: LEVEL_SELECT });
  }

  update(id: string, input: MentorLevelUpdateInput): Promise<MentorLevelRow> {
    return this.prisma.mentorLevel.update({ where: { id }, data: input, select: LEVEL_SELECT });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.mentorLevel.delete({ where: { id } });
  }

  // ──────────────────── История сотрудника по месяцам (ТЗ 5.14) ──────────────

  async findHistory(
    params: MentorLevelHistoryListParams,
  ): Promise<{ rows: MentorLevelHistoryRow[]; total: number }> {
    const where: Prisma.MentorLevelHistoryWhereInput = {
      employeeId: params.employeeId,
      ...(params.levelId === undefined ? {} : { levelId: params.levelId }),
      ...(params.from === undefined && params.to === undefined
        ? {}
        : {
            month: {
              ...(params.from === undefined ? {} : { gte: params.from }),
              ...(params.to === undefined ? {} : { lte: params.to }),
            },
          }),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.mentorLevelHistory.findMany({
        where,
        select: HISTORY_SELECT,
        orderBy: { month: params.order },
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.mentorLevelHistory.count({ where }),
    ]);

    return { rows, total };
  }

  /** Запись месяца адресуется естественным ключом — парой «сотрудник + месяц». */
  findHistoryEntry(employeeId: string, month: Date): Promise<MentorLevelHistoryRow | null> {
    return this.prisma.mentorLevelHistory.findUnique({
      where: { employeeId_month: { employeeId, month } },
      select: HISTORY_SELECT,
    });
  }

  /**
   * Простановка уровня на месяц. `upsert` по естественному ключу, а не `create`:
   * на сотрудника в месяце ровно одна запись (решение сессии 0021), поэтому
   * повторный `PUT` меняет ступень, а не заводит вторую строку.
   */
  setHistoryEntry(
    employeeId: string,
    month: Date,
    levelId: string,
  ): Promise<MentorLevelHistoryRow> {
    return this.prisma.mentorLevelHistory.upsert({
      where: { employeeId_month: { employeeId, month } },
      create: { employeeId, month, levelId },
      update: { levelId },
      select: HISTORY_SELECT,
    });
  }

  async deleteHistoryEntry(employeeId: string, month: Date): Promise<void> {
    await this.prisma.mentorLevelHistory.delete({
      where: { employeeId_month: { employeeId, month } },
    });
  }

  // ─────────────────────────── Ссылки из тела запроса ────────────────────────

  /** Сотрудник из пути: несуществующий даёт 404 до разбора тела. */
  findEmployee(id: string): Promise<{ id: string; firstName: string; lastName: string } | null> {
    return this.prisma.employee.findUnique({
      where: { id },
      select: { id: true, firstName: true, lastName: true },
    });
  }

  /** Ступень из тела запроса: несуществующая даёт 422, а не ошибку внешнего ключа. */
  findLevel(id: string): Promise<LevelCandidate | null> {
    return this.prisma.mentorLevel.findUnique({
      where: { id },
      select: { id: true, name: true, status: true },
    });
  }
}

const orderByOf = (
  sort: MentorLevelSortField,
  order: SortOrder,
): Prisma.MentorLevelOrderByWithRelationInput => {
  switch (sort) {
    case MentorLevelSortField.Name:
      return { name: order };
    case MentorLevelSortField.CreatedAt:
      return { createdAt: order };
    default:
      return { hourlyRate: order };
  }
};
