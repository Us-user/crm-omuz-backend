import { Injectable } from '@nestjs/common';
import type { DirectoryStatus, Prisma } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { BranchSortField } from './dto';

const BRANCH_SELECT = {
  id: true,
  name: true,
  city: true,
  district: true,
  address: true,
  phone: true,
  description: true,
  status: true,
  createdAt: true,
  // Счётчики, а не сами строки: у филиала могут быть сотни студентов, и возить
  // их ради числа на карточке значило бы тянуть таблицу на каждую страницу списка.
  _count: { select: { rooms: true, students: true, employees: true, groups: true, leads: true } },
} satisfies Prisma.BranchSelect;

export type BranchRow = Prisma.BranchGetPayload<{ select: typeof BRANCH_SELECT }>;

export interface BranchListParams {
  search?: string;
  status?: DirectoryStatus;
  sort: BranchSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface BranchWriteInput {
  name: string;
  city: string;
  district: string | null;
  address: string;
  phone: string | null;
  description: string | null;
  status?: DirectoryStatus;
}

/** `undefined` — колонку не менять; значение (включая `null`) — записать. */
export type BranchUpdateInput = Partial<BranchWriteInput>;

/**
 * Доступ к данным филиалов (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class BranchesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: BranchListParams): Promise<{ rows: BranchRow[]; total: number }> {
    const where: Prisma.BranchWhereInput = {
      ...(params.status === undefined ? {} : { status: params.status }),
      ...(params.search === undefined
        ? {}
        : {
            OR: [
              { name: { contains: params.search, mode: 'insensitive' } },
              { city: { contains: params.search, mode: 'insensitive' } },
              { district: { contains: params.search, mode: 'insensitive' } },
              { address: { contains: params.search, mode: 'insensitive' } },
            ],
          }),
    };

    // Ключ `orderBy` собирается ветвлением, а не из строки: вычисляемое поле
    // прошло бы типизацию Prisma и упало бы уже в БД.
    const orderBy: Prisma.BranchOrderByWithRelationInput =
      params.sort === BranchSortField.Name
        ? { name: params.order }
        : params.sort === BranchSortField.City
          ? { city: params.order }
          : { createdAt: params.order };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.branch.findMany({
        where,
        select: BRANCH_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.branch.count({ where }),
    ]);

    return { rows, total };
  }

  findById(id: string): Promise<BranchRow | null> {
    return this.prisma.branch.findUnique({ where: { id }, select: BRANCH_SELECT });
  }

  /**
   * Поиск тёзки без учёта регистра. Уникальный индекс регистр учитывает, но
   * «Sadbarg» и «sadbarg» человек читает как один и тот же филиал.
   */
  findByName(name: string): Promise<{ id: string; name: string } | null> {
    return this.prisma.branch.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
  }

  create(input: BranchWriteInput): Promise<BranchRow> {
    return this.prisma.branch.create({ data: input, select: BRANCH_SELECT });
  }

  update(id: string, input: BranchUpdateInput): Promise<BranchRow> {
    // `undefined` Prisma пропускает: не переданное поле остаётся прежним.
    return this.prisma.branch.update({ where: { id }, data: input, select: BRANCH_SELECT });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.branch.delete({ where: { id } });
  }
}
