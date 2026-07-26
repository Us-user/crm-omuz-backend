import { Injectable } from '@nestjs/common';
import type { DirectoryStatus, Prisma } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { RoomSortField } from './dto';

const ROOM_SELECT = {
  id: true,
  name: true,
  capacity: true,
  floor: true,
  description: true,
  status: true,
  createdAt: true,
  // Название филиала отдаётся вместе с аудиторией: список без него был бы
  // набором номеров без указания, где эти комнаты находятся.
  branch: { select: { id: true, name: true } },
} satisfies Prisma.RoomSelect;

export type RoomRow = Prisma.RoomGetPayload<{ select: typeof ROOM_SELECT }>;

export interface RoomListParams {
  search?: string;
  branchId?: string;
  status?: DirectoryStatus;
  sort: RoomSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface RoomWriteInput {
  branchId: string;
  name: string;
  capacity: number | null;
  floor: number | null;
  description: string | null;
  status?: DirectoryStatus;
}

/** `undefined` — колонку не менять; значение (включая `null`) — записать. */
export type RoomUpdateInput = Partial<RoomWriteInput>;

/**
 * Доступ к данным аудиторий (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class RoomsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: RoomListParams): Promise<{ rows: RoomRow[]; total: number }> {
    const where: Prisma.RoomWhereInput = {
      ...(params.branchId === undefined ? {} : { branchId: params.branchId }),
      ...(params.status === undefined ? {} : { status: params.status }),
      ...(params.search === undefined
        ? {}
        : {
            OR: [
              { name: { contains: params.search, mode: 'insensitive' } },
              { description: { contains: params.search, mode: 'insensitive' } },
              { branch: { name: { contains: params.search, mode: 'insensitive' } } },
            ],
          }),
    };

    const orderBy: Prisma.RoomOrderByWithRelationInput =
      params.sort === RoomSortField.Name
        ? { name: params.order }
        : params.sort === RoomSortField.Capacity
          ? // Пустая вместимость уезжает в конец при любом направлении: комната
            // без указанной вместимости — не «самая маленькая».
            { capacity: { sort: params.order, nulls: 'last' } }
          : { createdAt: params.order };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.room.findMany({
        where,
        select: ROOM_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.room.count({ where }),
    ]);

    return { rows, total };
  }

  findById(id: string): Promise<RoomRow | null> {
    return this.prisma.room.findUnique({ where: { id }, select: ROOM_SELECT });
  }

  /**
   * Тёзка внутри филиала, без учёта регистра. Составной уникальный индекс
   * регистр учитывает, а «101» и «101 » после обрезки пробелов — одна комната.
   */
  findByName(branchId: string, name: string): Promise<{ id: string; name: string } | null> {
    return this.prisma.room.findFirst({
      where: { branchId, name: { equals: name, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
  }

  findBranch(id: string): Promise<{ id: string; name: string } | null> {
    return this.prisma.branch.findUnique({ where: { id }, select: { id: true, name: true } });
  }

  /**
   * Сколько занятий стоит в этой аудитории (ТЗ 5.5, расписание групп).
   * Отдельный запрос, а не `_count` в выборке: счётчик нужен только удалению,
   * а в `_count` он считался бы на каждую строку списка аудиторий.
   */
  countScheduleSlots(roomId: string): Promise<number> {
    return this.prisma.scheduleSlot.count({ where: { roomId } });
  }

  create(input: RoomWriteInput): Promise<RoomRow> {
    return this.prisma.room.create({ data: input, select: ROOM_SELECT });
  }

  update(id: string, input: RoomUpdateInput): Promise<RoomRow> {
    return this.prisma.room.update({ where: { id }, data: input, select: ROOM_SELECT });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.room.delete({ where: { id } });
  }
}
