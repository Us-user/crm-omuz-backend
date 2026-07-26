import { Injectable } from '@nestjs/common';
import type { AccountStatus, AccountType, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { SortOrder } from '../common';
import { AdminUserSortField } from './dto';

const ROLE_SELECT = { id: true, name: true, isSystem: true } satisfies Prisma.PositionSelect;

export type RoleRow = Prisma.PositionGetPayload<{ select: typeof ROLE_SELECT }>;

const ACCOUNT_LIST_SELECT = {
  id: true,
  phone: true,
  email: true,
  type: true,
  status: true,
  locale: true,
  lastLoginAt: true,
  createdAt: true,
  student: { select: { id: true, firstName: true, lastName: true } },
  employee: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      positions: { select: { position: { select: ROLE_SELECT } } },
    },
  },
} satisfies Prisma.AccountSelect;

export type AdminUserRow = Prisma.AccountGetPayload<{ select: typeof ACCOUNT_LIST_SELECT }>;

/** Аккаунт в объёме, нужном для назначения ролей. */
export interface AccountForRoles {
  id: string;
  type: AccountType;
  employee: { id: string; positionIds: string[] } | null;
}

export interface AdminUserListParams {
  search?: string;
  type?: AccountType;
  status?: AccountStatus;
  sort: AdminUserSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

/**
 * Доступ к данным `Administration → Users` (ТЗ 5.15): список аккаунтов
 * и назначение им позиций. Только запросы Prisma.
 */
@Injectable()
export class AdminUsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: AdminUserListParams): Promise<{ rows: AdminUserRow[]; total: number }> {
    const where = buildWhere(params);

    const orderBy: Prisma.AccountOrderByWithRelationInput =
      params.sort === AdminUserSortField.Phone
        ? { phone: params.order }
        : params.sort === AdminUserSortField.LastLoginAt
          ? { lastLoginAt: params.order }
          : { createdAt: params.order };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.account.findMany({
        where,
        select: ACCOUNT_LIST_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.account.count({ where }),
    ]);

    return { rows, total };
  }

  async findAccountForRoles(accountId: string): Promise<AccountForRoles | null> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        type: true,
        employee: { select: { id: true, positions: { select: { positionId: true } } } },
      },
    });

    if (!account) return null;

    return {
      id: account.id,
      type: account.type,
      employee: account.employee
        ? {
            id: account.employee.id,
            positionIds: account.employee.positions.map(({ positionId }) => positionId),
          }
        : null,
    };
  }

  findPositionsByIds(ids: readonly string[]): Promise<RoleRow[]> {
    return this.prisma.position.findMany({ where: { id: { in: [...ids] } }, select: ROLE_SELECT });
  }

  /** Роли сотрудника после изменения — их и возвращает эндпоинт. */
  async findEmployeeRoles(employeeId: string): Promise<RoleRow[]> {
    const rows = await this.prisma.employeePosition.findMany({
      where: { employeeId },
      select: { position: { select: ROLE_SELECT } },
    });

    return rows.map(({ position }) => position);
  }

  /** Уже назначенные позиции пропускаются: повторный «Add roles» не должен падать. */
  async assignPositions(employeeId: string, positionIds: readonly string[]): Promise<number> {
    const { count } = await this.prisma.employeePosition.createMany({
      data: positionIds.map((positionId) => ({ employeeId, positionId })),
      skipDuplicates: true,
    });

    return count;
  }

  async removePositions(employeeId: string, positionIds: readonly string[]): Promise<number> {
    const { count } = await this.prisma.employeePosition.deleteMany({
      where: { employeeId, positionId: { in: [...positionIds] } },
    });

    return count;
  }

  /** Сколько сотрудников занимают позицию — нужно правилу «последний Director». */
  countPositionAssignments(positionId: string): Promise<number> {
    return this.prisma.employeePosition.count({ where: { positionId } });
  }
}

function buildWhere(params: AdminUserListParams): Prisma.AccountWhereInput {
  const where: Prisma.AccountWhereInput = { type: params.type, status: params.status };

  if (params.search === undefined) return where;

  // Имя лежит в профиле, а не в аккаунте (решение Фазы 1: аккаунт держит только
  // идентичность), поэтому поиск идёт и по двум профильным таблицам.
  const search = params.search;
  const byName: Prisma.StringFilter = { contains: search, mode: 'insensitive' };

  return {
    ...where,
    OR: [
      { phone: { contains: search } },
      { email: { contains: search, mode: 'insensitive' } },
      { student: { is: { OR: [{ firstName: byName }, { lastName: byName }] } } },
      { employee: { is: { OR: [{ firstName: byName }, { lastName: byName }] } } },
    ],
  };
}
