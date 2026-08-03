import { Injectable } from '@nestjs/common';
import type { AccountType, Prisma } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';

/** Строка журнала в том виде, в каком её показывает экран Logs (ТЗ 5.15). */
const AUDIT_LOG_SELECT = {
  id: true,
  accountId: true,
  actorName: true,
  actorPhone: true,
  actorType: true,
  action: true,
  method: true,
  path: true,
  entityId: true,
  statusCode: true,
  requestId: true,
  ip: true,
  userAgent: true,
  createdAt: true,
} satisfies Prisma.AuditLogSelect;

export type AuditLogRow = Prisma.AuditLogGetPayload<{ select: typeof AUDIT_LOG_SELECT }>;

/** Что известно об аккаунте на момент записи — снимок уходит в строку журнала. */
export interface AuditActor {
  phone: string;
  type: AccountType;
  firstName: string | null;
  lastName: string | null;
}

export interface AuditLogWriteInput {
  accountId: string | null;
  actorName: string | null;
  actorPhone: string | null;
  actorType: AccountType | null;
  action: string;
  method: string;
  path: string;
  entityId: string | null;
  statusCode: number;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface AuditLogListParams {
  search?: string;
  accountId?: string;
  actorType?: AccountType;
  action?: string;
  entityId?: string;
  /** Успех — код меньше 400, отказ — 401/403 (других в журнале не бывает). */
  succeeded?: boolean;
  /** Полуинтервал по времени: `from` включительно, `to` — уже следующие сутки. */
  from?: Date;
  to?: Date;
  order: SortOrder;
  skip: number;
  take: number;
}

const whereOf = (params: AuditLogListParams): Prisma.AuditLogWhereInput => {
  const conditions: Prisma.AuditLogWhereInput[] = [];

  if (params.accountId !== undefined) conditions.push({ accountId: params.accountId });
  if (params.actorType !== undefined) conditions.push({ actorType: params.actorType });
  if (params.action !== undefined) conditions.push({ action: params.action });
  if (params.entityId !== undefined) conditions.push({ entityId: params.entityId });

  if (params.succeeded !== undefined) {
    conditions.push({ statusCode: params.succeeded ? { lt: 400 } : { gte: 400 } });
  }

  if (params.from !== undefined || params.to !== undefined) {
    conditions.push({ createdAt: { gte: params.from, lt: params.to } });
  }

  // Поиск идёт по тому, что человек помнит про действие: кто и что.
  if (params.search !== undefined) {
    conditions.push({
      OR: [
        { actorName: { contains: params.search, mode: 'insensitive' } },
        { actorPhone: { contains: params.search, mode: 'insensitive' } },
        { action: { contains: params.search, mode: 'insensitive' } },
        { path: { contains: params.search, mode: 'insensitive' } },
      ],
    });
  }

  // Условия собираются массивом `AND`: поиск приносит собственный `OR`,
  // и при склейке через spread он молча затёр бы соседа (приём 0027).
  return conditions.length === 0 ? {} : { AND: conditions };
};

/**
 * Доступ к журналу действий (`Controller → Service → Repository`).
 *
 * Журнал только пишется и читается: правок и удаления у него нет по определению —
 * запись, которую можно изменить, аудитом не является (ТЗ 3.6, 7).
 */
@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: AuditLogWriteInput): Promise<void> {
    await this.prisma.auditLog.create({ data: input, select: { id: true } });
  }

  /**
   * Снимок действующего лица. Отдельный запрос, а не связь при чтении: имя
   * и телефон обязаны пережить удаление аккаунта, а `SET NULL` ссылку обнулит.
   * Выполняется **после** ответа клиенту (запись журнала не ждут), поэтому
   * на время запроса не влияет.
   */
  async findActor(accountId: string): Promise<AuditActor | null> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: {
        phone: true,
        type: true,
        student: { select: { firstName: true, lastName: true } },
        employee: { select: { firstName: true, lastName: true } },
      },
    });

    if (!account) return null;

    const profile = account.employee ?? account.student;

    return {
      phone: account.phone,
      type: account.type,
      firstName: profile?.firstName ?? null,
      lastName: profile?.lastName ?? null,
    };
  }

  async findMany(params: AuditLogListParams): Promise<{ rows: AuditLogRow[]; total: number }> {
    const where = whereOf(params);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        select: AUDIT_LOG_SELECT,
        // Единственный осмысленный порядок у журнала — по времени (ТЗ 5.15:
        // «Logs — аудит по датам»), поэтому поле сортировки не выбирается.
        orderBy: { createdAt: params.order },
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { rows, total };
  }
}
