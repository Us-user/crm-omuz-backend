import { Injectable } from '@nestjs/common';
import type { AvansStatus, EmployeeStatus, Prisma } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { AvansSortField } from './dto';

/**
 * Строка заявки отдаётся вместе с профилями заведшего и рассмотревшего:
 * экран «заявки сотрудника» показывает, кто её подал и кто решил, и вторым
 * запросом за карточками он ходить не должен.
 *
 * Сотрудник, **которому** аванс, в выборку не входит: маршруты вложены
 * в `/employees/{id}`, то есть адрес уже говорит, о ком речь (так же устроена
 * история уровней в сессии 0021).
 */
const AVANS_SELECT = {
  id: true,
  employeeId: true,
  amount: true,
  reason: true,
  month: true,
  status: true,
  reviewedAt: true,
  reviewComment: true,
  createdAt: true,
  createdBy: { select: { id: true, firstName: true, lastName: true } },
  reviewedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.AvansRequestSelect;

export type AvansRequestRow = Prisma.AvansRequestGetPayload<{ select: typeof AVANS_SELECT }>;

/**
 * Заявка в очереди бухгалтерии (ТЗ 5.16, `GET /accounting/avans`) — та же
 * строка **плюс сотрудник, которому аванс**.
 *
 * Здесь он обязателен, в отличие от списка внутри `/employees/{id}/avans`:
 * очередь идёт по всему центру, и адрес про человека ничего не говорит.
 */
const AVANS_REVIEW_SELECT = {
  ...AVANS_SELECT,
  employee: { select: { id: true, firstName: true, lastName: true, status: true } },
} satisfies Prisma.AvansRequestSelect;

export type AvansReviewRow = Prisma.AvansRequestGetPayload<{
  select: typeof AVANS_REVIEW_SELECT;
}>;

/**
 * Отбор очереди рассмотрения. По умолчанию — все статусы: одобренные и
 * отклонённые заявки бухгалтерия читает тем же экраном, а `?status=PENDING`
 * оставляет то, что ждёт решения.
 */
export interface AvansReviewListParams {
  employeeId?: string;
  status?: AvansStatus;
  from?: Date;
  to?: Date;
  search?: string;
  sort: AvansSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface AvansReviewInput {
  status: AvansStatus;
  reviewedById: string | null;
  comment: string | null;
}

/** Сотрудник в том виде, в каком его проверяет подача заявки. */
export interface AvansEmployee {
  id: string;
  firstName: string;
  lastName: string;
  status: EmployeeStatus;
}

export interface AvansListParams {
  employeeId: string;
  status?: AvansStatus;
  from?: Date;
  to?: Date;
  sort: AvansSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface AvansCreateInput {
  employeeId: string;
  amount: number;
  reason: string;
  month: Date;
  createdById: string | null;
}

/**
 * Доступ к данным заявок на аванс (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class AvansRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: AvansListParams): Promise<{ rows: AvansRequestRow[]; total: number }> {
    const where: Prisma.AvansRequestWhereInput = {
      employeeId: params.employeeId,
      ...(params.status === undefined ? {} : { status: params.status }),
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
      this.prisma.avansRequest.findMany({
        where,
        select: AVANS_SELECT,
        orderBy: orderByOf(params.sort, params.order),
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.avansRequest.count({ where }),
    ]);

    return { rows, total };
  }

  /**
   * Заявка ищется **вместе с сотрудником из пути**, а не по одному `id`:
   * иначе `/employees/A/avans/{id}` отзывал бы заявку сотрудника B, и
   * вложенность адреса выглядела бы защитой, не будучи ею (решение сессии 0009
   * про урок внутри курса).
   */
  findByIdForEmployee(id: string, employeeId: string): Promise<AvansRequestRow | null> {
    return this.prisma.avansRequest.findFirst({ where: { id, employeeId }, select: AVANS_SELECT });
  }

  /** Нерассмотренная заявка сотрудника: на ней держится правило «одна `PENDING»`. */
  findPending(employeeId: string): Promise<AvansRequestRow | null> {
    return this.prisma.avansRequest.findFirst({
      where: { employeeId, status: 'PENDING' },
      select: AVANS_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  create(input: AvansCreateInput): Promise<AvansRequestRow> {
    return this.prisma.avansRequest.create({ data: input, select: AVANS_SELECT });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.avansRequest.delete({ where: { id } });
  }

  // ───────────────── Рассмотрение (ТЗ 5.16, бухгалтерия) ─────────────────────

  /** Очередь заявок по всему центру — с сотрудником в каждой строке. */
  async findManyForReview(
    params: AvansReviewListParams,
  ): Promise<{ rows: AvansReviewRow[]; total: number }> {
    const where: Prisma.AvansRequestWhereInput = {
      ...(params.employeeId === undefined ? {} : { employeeId: params.employeeId }),
      ...(params.status === undefined ? {} : { status: params.status }),
      ...(params.from === undefined && params.to === undefined
        ? {}
        : {
            month: {
              ...(params.from === undefined ? {} : { gte: params.from }),
              ...(params.to === undefined ? {} : { lte: params.to }),
            },
          }),
      ...(params.search === undefined
        ? {}
        : {
            OR: [
              { employee: { firstName: { contains: params.search, mode: 'insensitive' } } },
              { employee: { lastName: { contains: params.search, mode: 'insensitive' } } },
              { reason: { contains: params.search, mode: 'insensitive' } },
            ],
          }),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.avansRequest.findMany({
        where,
        select: AVANS_REVIEW_SELECT,
        orderBy: [orderByOf(params.sort, params.order), { id: 'asc' }],
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.avansRequest.count({ where }),
    ]);

    return { rows, total };
  }

  /** Заявка по идентификатору — очередь адресует её без сотрудника в пути. */
  findByIdForReview(id: string): Promise<AvansReviewRow | null> {
    return this.prisma.avansRequest.findUnique({ where: { id }, select: AVANS_REVIEW_SELECT });
  }

  /**
   * Решение по заявке. Статус, рассмотревший, время и комментарий пишутся
   * **одной операцией**: статус без «кто и когда» не отвечал бы на вопрос,
   * на каком основании выданы деньги (0022).
   *
   * Снятие рассмотрения возвращает заявку в `PENDING` и гасит все три колонки —
   * иначе в данных остался бы след решения, которого больше нет.
   */
  review(id: string, input: AvansReviewInput): Promise<AvansReviewRow> {
    const reviewed = input.status !== 'PENDING';

    return this.prisma.avansRequest.update({
      where: { id },
      data: {
        status: input.status,
        reviewedById: reviewed ? input.reviewedById : null,
        reviewedAt: reviewed ? new Date() : null,
        reviewComment: reviewed ? input.comment : null,
      },
      select: AVANS_REVIEW_SELECT,
    });
  }

  /** Сотрудник из пути: несуществующий даёт 404 до разбора тела. */
  findEmployee(id: string): Promise<AvansEmployee | null> {
    return this.prisma.employee.findUnique({
      where: { id },
      select: { id: true, firstName: true, lastName: true, status: true },
    });
  }

  /** Профиль вызывающего — он же автор заявки. `null` у аккаунта без профиля. */
  findEmployeeByAccount(accountId: string): Promise<{ id: string } | null> {
    return this.prisma.employee.findUnique({ where: { accountId }, select: { id: true } });
  }
}

const orderByOf = (
  sort: AvansSortField,
  order: SortOrder,
): Prisma.AvansRequestOrderByWithRelationInput => {
  switch (sort) {
    case AvansSortField.Month:
      return { month: order };
    case AvansSortField.Amount:
      return { amount: order };
    default:
      return { createdAt: order };
  }
};
