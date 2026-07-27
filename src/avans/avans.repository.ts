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
