import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { PositionSortField } from './dto';
import type { SortOrder } from '../common';

const POSITION_LIST_SELECT = {
  id: true,
  name: true,
  description: true,
  isSystem: true,
  createdAt: true,
  // Списку нужны только числа: у позиции может быть до сотни прав, и тянуть их
  // все ради счётчика на карточке значило бы возить лишние строки на каждую страницу.
  _count: { select: { permissions: true, employees: true } },
} satisfies Prisma.PositionSelect;

export type PositionListRow = Prisma.PositionGetPayload<{ select: typeof POSITION_LIST_SELECT }>;

const POSITION_DETAIL_SELECT = {
  ...POSITION_LIST_SELECT,
  permissions: { select: { permission: { select: { code: true } } } },
} satisfies Prisma.PositionSelect;

export type PositionDetailRow = Prisma.PositionGetPayload<{
  select: typeof POSITION_DETAIL_SELECT;
}>;

export interface PositionListParams {
  search?: string;
  sort: PositionSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface PositionWriteInput {
  name: string;
  description: string | null;
  /** Идентификаторы прав каталога; пустой массив — позиция без прав. */
  permissionIds: string[];
}

export interface PositionUpdateInput {
  name?: string;
  description?: string | null;
  /** `undefined` — набор галочек не трогаем; массив — заменяем целиком. */
  permissionIds?: string[];
}

/**
 * Доступ к данным справочника позиций (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class PositionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: PositionListParams): Promise<{ rows: PositionListRow[]; total: number }> {
    const where: Prisma.PositionWhereInput =
      params.search === undefined
        ? {}
        : {
            OR: [
              { name: { contains: params.search, mode: 'insensitive' } },
              { description: { contains: params.search, mode: 'insensitive' } },
            ],
          };

    // Ключ `orderBy` собирается ветвлением, а не из строки: вычисляемое поле
    // прошло бы типизацию Prisma и упало бы уже в БД.
    const orderBy: Prisma.PositionOrderByWithRelationInput =
      params.sort === PositionSortField.Name ? { name: params.order } : { createdAt: params.order };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.position.findMany({
        where,
        select: POSITION_LIST_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.position.count({ where }),
    ]);

    return { rows, total };
  }

  findById(id: string): Promise<PositionDetailRow | null> {
    return this.prisma.position.findUnique({ where: { id }, select: POSITION_DETAIL_SELECT });
  }

  /**
   * Поиск тёзки без учёта регистра. Уникальный индекс регистр учитывает, но позиция
   * `director` рядом с системной `Director` читалась бы человеком как та же самая,
   * а правило доступа к бухгалтерии сработало бы только для одной из них.
   */
  findByName(name: string): Promise<{ id: string; name: string } | null> {
    return this.prisma.position.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
  }

  /** Права каталога по кодам — сервис переводит коды в идентификаторы связок. */
  findPermissionsByCodes(codes: readonly string[]): Promise<{ id: string; code: string }[]> {
    return this.prisma.permission.findMany({
      where: { code: { in: [...codes] } },
      select: { id: true, code: true },
    });
  }

  /**
   * Позиция и её галочки создаются одной транзакцией: позиция без прав,
   * появившаяся из-за сбоя на середине, выглядела бы как настроенная.
   */
  create(input: PositionWriteInput): Promise<PositionDetailRow> {
    return this.prisma.$transaction(async (tx) => {
      const { id } = await tx.position.create({
        data: { name: input.name, description: input.description },
        select: { id: true },
      });

      if (input.permissionIds.length > 0) {
        await tx.positionPermission.createMany({
          data: input.permissionIds.map((permissionId) => ({ positionId: id, permissionId })),
          skipDuplicates: true,
        });
      }

      return tx.position.findUniqueOrThrow({ where: { id }, select: POSITION_DETAIL_SELECT });
    });
  }

  /** Набор прав заменяется целиком (снять галочку иначе было бы нечем). */
  update(id: string, input: PositionUpdateInput): Promise<PositionDetailRow> {
    return this.prisma.$transaction(async (tx) => {
      await tx.position.update({
        where: { id },
        // `undefined` Prisma пропускает: не переданное поле остаётся прежним.
        data: { name: input.name, description: input.description },
      });

      if (input.permissionIds !== undefined) {
        await tx.positionPermission.deleteMany({ where: { positionId: id } });

        if (input.permissionIds.length > 0) {
          await tx.positionPermission.createMany({
            data: input.permissionIds.map((permissionId) => ({ positionId: id, permissionId })),
            skipDuplicates: true,
          });
        }
      }

      return tx.position.findUniqueOrThrow({ where: { id }, select: POSITION_DETAIL_SELECT });
    });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.position.delete({ where: { id } });
  }
}
