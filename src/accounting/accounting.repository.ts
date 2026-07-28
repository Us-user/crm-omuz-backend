import { Injectable } from '@nestjs/common';
import type { DirectoryStatus, Prisma } from '@prisma/client';
import { GroupStatus, GroupStudentStatus } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import type { DebtorChargeTotals, DebtorDebt } from './accounting';
import { ChargeStatus, dueCentsOf, toCents } from './accounting';
import { ChargeSortField, PaymentTypeSortField, TransactionSortField } from './dto';

// ───────────────────────────── Выборки строк ─────────────────────────────────

const PAYMENT_TYPE_SELECT = {
  id: true,
  name: true,
  description: true,
  status: true,
  createdAt: true,
  _count: { select: { transactions: true } },
} satisfies Prisma.PaymentTypeSelect;

export type PaymentTypeRow = Prisma.PaymentTypeGetPayload<{ select: typeof PAYMENT_TYPE_SELECT }>;

/**
 * Строка списка начислений (ТЗ 5.16). Студент, группа, курс и филиал отдаются
 * вместе со строкой: экран «Payment's» читают целиком, и догрузка каждого поля
 * превратила бы одну таблицу в сотню запросов (приём сессий 0025–0026).
 */
const CHARGE_SELECT = {
  id: true,
  month: true,
  amount: true,
  discount: true,
  discountReason: true,
  paidAmount: true,
  remainingAmount: true,
  note: true,
  createdAt: true,
  student: { select: { id: true, firstName: true, lastName: true, phone: true } },
  group: {
    select: {
      id: true,
      name: true,
      course: { select: { id: true, title: true } },
      branch: { select: { id: true, name: true } },
    },
  },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.StudentPaymentSelect;

export type ChargeRow = Prisma.StudentPaymentGetPayload<{ select: typeof CHARGE_SELECT }>;

const TRANSACTION_SELECT = {
  id: true,
  amount: true,
  paidAt: true,
  comment: true,
  editReason: true,
  editedAt: true,
  createdAt: true,
  student: { select: { id: true, firstName: true, lastName: true, phone: true } },
  charge: {
    select: { id: true, month: true, group: { select: { id: true, name: true } } },
  },
  type: { select: { id: true, name: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
  editedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.PaymentTransactionSelect;

export type TransactionRow = Prisma.PaymentTransactionGetPayload<{
  select: typeof TRANSACTION_SELECT;
}>;

/** Карточка начисления: та же строка плюс платежи, которые её закрывают. */
export interface ChargeCard {
  charge: ChargeRow;
  transactions: TransactionRow[];
}

/** Группа в том виде, в каком её видит начисление месяца: состав и Fee курса. */
export type ChargeableGroup = Prisma.GroupGetPayload<{
  select: {
    id: true;
    name: true;
    status: true;
    course: { select: { id: true; title: true; fee: true } };
    students: { select: { studentId: true } };
  };
}>;

export interface StudentProfile {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  status: string;
  branch: { id: string; name: string } | null;
}

// ───────────────────────────── Параметры выборок ─────────────────────────────

/**
 * Отбор начислений — общий для списка, для итогов `meta` и для витрины
 * должников: три числа на соседних экранах обязаны считаться по одному набору
 * строк **по определению**, а не по совпадению (приём сессий 0013, 0025, 0026).
 *
 * `from` включающая, `to` — **не** включающая (первое число месяца, следующего
 * за концом периода).
 */
export interface ChargeFilter {
  studentId?: string;
  groupId?: string;
  courseId?: string;
  branchId?: string;
  from?: Date;
  to?: Date;
  status?: ChargeStatus;
  search?: string;
}

export interface ChargeListParams extends ChargeFilter {
  sort: ChargeSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface TransactionFilter {
  studentId?: string;
  chargeId?: string;
  typeId?: string;
  prepayment?: boolean;
  from?: Date;
  to?: Date;
  search?: string;
}

export interface TransactionListParams extends TransactionFilter {
  sort: TransactionSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface PaymentTypeListParams {
  status?: DirectoryStatus;
  search?: string;
  sort: PaymentTypeSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface PaymentTypeWriteInput {
  name?: string;
  description?: string | null;
  status?: DirectoryStatus;
}

/** Строка нового начисления: сумма — снимок Fee курса на момент запуска. */
export interface ChargeInput {
  studentId: string;
  groupId: string;
  amountCents: number;
}

export interface ChargeUpdateInput {
  discountCents?: number;
  discountReason?: string | null;
  note?: string | null;
}

export interface TransactionInput {
  studentId: string;
  chargeId: string | null;
  amountCents: number;
  paidAt: Date;
  typeId: string | null;
  comment: string | null;
  createdById: string | null;
}

/** `undefined` — колонку не менять; значение (включая `null`) — записать. */
export interface TransactionUpdateInput {
  amountCents?: number;
  paidAt?: Date;
  typeId?: string | null;
  comment?: string | null;
  chargeId?: string | null;
  editReason: string;
  editedById: string | null;
}

/**
 * Деньги в БД: `Decimal` принимает строку, и строка честнее числа — двоичная
 * плавающая точка не участвует в записи вообще (`fromCents` вернул бы число,
 * которое пришлось бы доверять драйверу).
 */
const money = (cents: number): string => (Math.round(cents) / 100).toFixed(2);

const chargeWhereOf = (filter: ChargeFilter): Prisma.StudentPaymentWhereInput => {
  const group: Prisma.GroupWhereInput = {
    ...(filter.courseId === undefined ? {} : { courseId: filter.courseId }),
    ...(filter.branchId === undefined ? {} : { branchId: filter.branchId }),
  };

  const month: Prisma.DateTimeFilter = {
    ...(filter.from === undefined ? {} : { gte: filter.from }),
    ...(filter.to === undefined ? {} : { lt: filter.to }),
  };

  // Статус месяца выражается двумя хранимыми колонками ровно так же, как его
  // считает `chargeStatusOf`: остаток отвечает за «закрыт ли месяц», принятая
  // сумма — за «начинали ли платить». Без денормализации этот фильтр
  // потребовал бы сравнения агрегата связи с колонкой, чего Prisma не строит.
  const status: Prisma.StudentPaymentWhereInput =
    filter.status === undefined
      ? {}
      : filter.status === ChargeStatus.Paid
        ? { remainingAmount: 0 }
        : filter.status === ChargeStatus.Partial
          ? { remainingAmount: { gt: 0 }, paidAmount: { gt: 0 } }
          : { remainingAmount: { gt: 0 }, paidAmount: 0 };

  return {
    ...(filter.studentId === undefined ? {} : { studentId: filter.studentId }),
    ...(filter.groupId === undefined ? {} : { groupId: filter.groupId }),
    ...(Object.keys(group).length === 0 ? {} : { group }),
    ...(Object.keys(month).length === 0 ? {} : { month }),
    ...status,
    ...(filter.search === undefined
      ? {}
      : {
          OR: [
            { student: { firstName: { contains: filter.search, mode: 'insensitive' } } },
            { student: { lastName: { contains: filter.search, mode: 'insensitive' } } },
            { student: { phone: { contains: filter.search } } },
            { group: { name: { contains: filter.search, mode: 'insensitive' } } },
          ],
        }),
  };
};

const transactionWhereOf = (filter: TransactionFilter): Prisma.PaymentTransactionWhereInput => {
  const paidAt: Prisma.DateTimeFilter = {
    ...(filter.from === undefined ? {} : { gte: filter.from }),
    ...(filter.to === undefined ? {} : { lt: filter.to }),
  };

  return {
    ...(filter.studentId === undefined ? {} : { studentId: filter.studentId }),
    ...(filter.chargeId === undefined ? {} : { chargeId: filter.chargeId }),
    ...(filter.typeId === undefined ? {} : { typeId: filter.typeId }),
    // Предоплата — это платёж без месяца, и оба значения фильтра делают
    // осмысленное дело: «только предоплаты» и «только разнесённые по месяцам»
    // (правило сессий 0017–0018 про параметры, которые молча ничего не делают).
    ...(filter.prepayment === undefined
      ? {}
      : filter.prepayment
        ? { chargeId: null }
        : { chargeId: { not: null } }),
    ...(Object.keys(paidAt).length === 0 ? {} : { paidAt }),
    ...(filter.search === undefined
      ? {}
      : {
          OR: [
            { student: { firstName: { contains: filter.search, mode: 'insensitive' } } },
            { student: { lastName: { contains: filter.search, mode: 'insensitive' } } },
            { student: { phone: { contains: filter.search } } },
            { comment: { contains: filter.search, mode: 'insensitive' } },
          ],
        }),
  };
};

/**
 * Доступ к данным платёжного контура (`Controller → Service → Repository`).
 *
 * Один репозиторий на три таблицы — как `MentorLevelsRepository` на справочник
 * и историю (0021): они связаны правилами, которые нельзя разнести (способ
 * оплаты держится платежами, платёж пересчитывает начисление), и разведённые
 * репозитории заставили бы e2e держать в согласии два хранилища ради одного
 * набора правил.
 *
 * Бизнес-правил здесь нет: статусы, итоги и долги считают чистые функции
 * из `accounting.ts`. Единственное исключение — пересчёт `paidAmount`
 * и `remainingAmount`: он обязан идти **той же транзакцией**, что и сам платёж,
 * поэтому живёт рядом с записью.
 */
@Injectable()
export class AccountingRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ────────────────────── Справочник способов оплаты ────────────────────────

  async findManyTypes(
    params: PaymentTypeListParams,
  ): Promise<{ rows: PaymentTypeRow[]; total: number }> {
    const where: Prisma.PaymentTypeWhereInput = {
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

    const orderBy: Prisma.PaymentTypeOrderByWithRelationInput =
      params.sort === PaymentTypeSortField.CreatedAt
        ? { createdAt: params.order }
        : { name: params.order };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.paymentType.findMany({
        where,
        select: PAYMENT_TYPE_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.paymentType.count({ where }),
    ]);

    return { rows, total };
  }

  findTypeById(id: string): Promise<PaymentTypeRow | null> {
    return this.prisma.paymentType.findUnique({ where: { id }, select: PAYMENT_TYPE_SELECT });
  }

  /** Тёзка без учёта регистра — как у купонов (0027) и филиалов (0007). */
  findTypeByName(name: string): Promise<{ id: string; name: string } | null> {
    return this.prisma.paymentType.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
  }

  createType(input: Required<Pick<PaymentTypeWriteInput, 'name'>> & PaymentTypeWriteInput) {
    return this.prisma.paymentType.create({
      data: { name: input.name, description: input.description ?? null, status: input.status },
      select: PAYMENT_TYPE_SELECT,
    });
  }

  updateType(id: string, input: PaymentTypeWriteInput): Promise<PaymentTypeRow> {
    return this.prisma.paymentType.update({
      where: { id },
      data: input,
      select: PAYMENT_TYPE_SELECT,
    });
  }

  async deleteType(id: string): Promise<void> {
    await this.prisma.paymentType.delete({ where: { id } });
  }

  // ───────────────────────────── Начисления ─────────────────────────────────

  async findManyCharges(params: ChargeListParams): Promise<{ rows: ChargeRow[]; total: number }> {
    const where = chargeWhereOf(params);

    const orderBy: Prisma.StudentPaymentOrderByWithRelationInput[] =
      params.sort === ChargeSortField.Name
        ? [{ student: { lastName: params.order } }, { student: { firstName: params.order } }]
        : params.sort === ChargeSortField.Amount
          ? [{ amount: params.order }]
          : params.sort === ChargeSortField.Debt
            ? [{ remainingAmount: params.order }]
            : // По умолчанию — свежие месяцы сверху; внутри месяца порядок
              // закреплён идентификатором, иначе строка приходила бы на двух
              // страницах подряд (приём сессии 0024).
              [{ month: params.order }, { id: 'asc' }];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.studentPayment.findMany({
        where,
        select: CHARGE_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.studentPayment.count({ where }),
    ]);

    return { rows, total };
  }

  /**
   * Итоги «Total payment / Paid / Not paid» (ТЗ 5.16) по **всему** отобранному
   * набору, а не по странице: они одни на все страницы и уходят в `meta` —
   * тот же случай, что баланс коинов (0018) и пьедестал рейтинга (0024).
   */
  async aggregateCharges(
    filter: ChargeFilter,
  ): Promise<{ chargedCents: number; paidCents: number }> {
    const sums = await this.prisma.studentPayment.aggregate({
      where: chargeWhereOf(filter),
      _sum: { amount: true, discount: true, paidAmount: true },
    });

    const amount = sums._sum.amount === null ? 0 : toCents(sums._sum.amount);
    const discount = sums._sum.discount === null ? 0 : toCents(sums._sum.discount);
    const paid = sums._sum.paidAmount === null ? 0 : toCents(sums._sum.paidAmount);

    return { chargedCents: Math.max(0, amount - discount), paidCents: paid };
  }

  findChargeById(id: string): Promise<ChargeRow | null> {
    return this.prisma.studentPayment.findUnique({ where: { id }, select: CHARGE_SELECT });
  }

  /**
   * Карточка месяца вместе с платежами. Список платежей нужен не для красоты:
   * по нему сервис пересчитывает принятую сумму и сверяет её с хранимой —
   * расхождение денормализации обязано быть видно там, где это ничего не стоит.
   */
  async findChargeCard(id: string): Promise<ChargeCard | null> {
    const charge = await this.findChargeById(id);
    if (charge === null) return null;

    const transactions = await this.prisma.paymentTransaction.findMany({
      where: { chargeId: id },
      select: TRANSACTION_SELECT,
      orderBy: [{ paidAt: 'desc' }, { id: 'asc' }],
    });

    return { charge, transactions };
  }

  countChargeTransactions(chargeId: string): Promise<number> {
    return this.prisma.paymentTransaction.count({ where: { chargeId } });
  }

  /** Группа со статусом и стоимостью курса — для начисления по одной группе. */
  findGroupById(
    groupId: string,
  ): Promise<{ id: string; name: string; status: GroupStatus } | null> {
    return this.prisma.group.findUnique({
      where: { id: groupId },
      select: { id: true, name: true, status: true },
    });
  }

  /**
   * Группы, которым начисляется месяц, вместе с действующим составом.
   *
   * Отменённые группы (`CANCELLED`) не начисляются: набор не состоялся,
   * и выставлять за него счёт нечему. Остальные статусы начисляются все —
   * группа завершается в середине месяца, за который платить всё равно нужно.
   */
  findChargeableGroups(groupId?: string): Promise<ChargeableGroup[]> {
    return this.prisma.group.findMany({
      where: {
        status: { not: GroupStatus.CANCELLED },
        ...(groupId === undefined ? {} : { id: groupId }),
      },
      select: {
        id: true,
        name: true,
        status: true,
        course: { select: { id: true, title: true, fee: true } },
        students: {
          where: { status: GroupStudentStatus.ACTIVE },
          select: { studentId: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Начисление месяца — одной транзакцией. `skipDuplicates` делает запуск
   * идемпотентным на уникальном ключе «студент + группа + месяц»: повторное
   * начисление того же месяца не заводит вторых строк (тот же приём,
   * что у автовыпуска, 0026).
   */
  async createCharges(
    month: Date,
    inputs: ChargeInput[],
    createdById: string | null,
  ): Promise<ChargeRow[]> {
    if (inputs.length === 0) return [];

    return this.prisma.$transaction(async (tx) => {
      await tx.studentPayment.createMany({
        data: inputs.map((input) => ({
          studentId: input.studentId,
          groupId: input.groupId,
          month,
          amount: money(input.amountCents),
          // Скидки при начислении нет, поэтому остаток равен сумме.
          remainingAmount: money(input.amountCents),
          createdById,
        })),
        skipDuplicates: true,
      });

      return tx.studentPayment.findMany({
        where: {
          month,
          OR: inputs.map(({ studentId, groupId }) => ({ studentId, groupId })),
        },
        select: CHARGE_SELECT,
        orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
      });
    });
  }

  /** Какие из этих пар «студент + группа» на этот месяц уже начислены. */
  async findExistingChargeKeys(month: Date, groupIds: string[]): Promise<Set<string>> {
    if (groupIds.length === 0) return new Set();

    const rows = await this.prisma.studentPayment.findMany({
      where: { month, groupId: { in: groupIds } },
      select: { studentId: true, groupId: true },
    });

    return new Set(rows.map(({ studentId, groupId }) => `${groupId}:${studentId}`));
  }

  /**
   * Правка скидки и примечания. Остаток пересчитывается **той же транзакцией**:
   * скидка меняет «к оплате», а значит и статус месяца.
   */
  async updateCharge(id: string, input: ChargeUpdateInput): Promise<ChargeRow> {
    return this.prisma.$transaction(async (tx) => {
      await tx.studentPayment.update({
        where: { id },
        data: {
          ...(input.discountCents === undefined ? {} : { discount: money(input.discountCents) }),
          ...(input.discountReason === undefined ? {} : { discountReason: input.discountReason }),
          ...(input.note === undefined ? {} : { note: input.note }),
        },
      });

      await recalcCharge(tx, id);

      return tx.studentPayment.findUniqueOrThrow({ where: { id }, select: CHARGE_SELECT });
    });
  }

  async deleteCharge(id: string): Promise<void> {
    await this.prisma.studentPayment.delete({ where: { id } });
  }

  // ────────────────────────────── Платежи ───────────────────────────────────

  async findManyTransactions(
    params: TransactionListParams,
  ): Promise<{ rows: TransactionRow[]; total: number; sumCents: number }> {
    const where = transactionWhereOf(params);

    const orderBy: Prisma.PaymentTransactionOrderByWithRelationInput[] =
      params.sort === TransactionSortField.Amount
        ? [{ amount: params.order }]
        : params.sort === TransactionSortField.Name
          ? [{ student: { lastName: params.order } }, { student: { firstName: params.order } }]
          : [{ paidAt: params.order }, { id: 'asc' }];

    const [rows, total, sums] = await this.prisma.$transaction([
      this.prisma.paymentTransaction.findMany({
        where,
        select: TRANSACTION_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.paymentTransaction.count({ where }),
      this.prisma.paymentTransaction.aggregate({ where, _sum: { amount: true } }),
    ]);

    return {
      rows,
      total,
      sumCents: sums._sum.amount === null ? 0 : toCents(sums._sum.amount),
    };
  }

  findTransactionById(id: string): Promise<TransactionRow | null> {
    return this.prisma.paymentTransaction.findUnique({
      where: { id },
      select: TRANSACTION_SELECT,
    });
  }

  /** Приём денег: платёж по месяцу или предоплата (`chargeId = null`). */
  async createTransaction(input: TransactionInput): Promise<TransactionRow> {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.paymentTransaction.create({
        data: {
          studentId: input.studentId,
          chargeId: input.chargeId,
          amount: money(input.amountCents),
          paidAt: input.paidAt,
          typeId: input.typeId,
          comment: input.comment,
          createdById: input.createdById,
        },
        select: { id: true },
      });

      if (input.chargeId !== null) await recalcCharge(tx, input.chargeId);

      return tx.paymentTransaction.findUniqueOrThrow({
        where: { id: created.id },
        select: TRANSACTION_SELECT,
      });
    });
  }

  /**
   * Правка платежа с причиной (ТЗ 5.16). Пересчитываются **оба** затронутых
   * месяца: разнесённая предоплата приходит в новый месяц и уходит из старого,
   * и пересчёт только одного оставил бы второй с чужой суммой.
   */
  async updateTransaction(
    id: string,
    input: TransactionUpdateInput,
    affectedChargeIds: string[],
  ): Promise<TransactionRow> {
    return this.prisma.$transaction(async (tx) => {
      await tx.paymentTransaction.update({
        where: { id },
        data: {
          ...(input.amountCents === undefined ? {} : { amount: money(input.amountCents) }),
          ...(input.paidAt === undefined ? {} : { paidAt: input.paidAt }),
          ...(input.typeId === undefined ? {} : { typeId: input.typeId }),
          ...(input.comment === undefined ? {} : { comment: input.comment }),
          ...(input.chargeId === undefined ? {} : { chargeId: input.chargeId }),
          editReason: input.editReason,
          editedAt: new Date(),
          editedById: input.editedById,
        },
      });

      for (const chargeId of affectedChargeIds) await recalcCharge(tx, chargeId);

      return tx.paymentTransaction.findUniqueOrThrow({ where: { id }, select: TRANSACTION_SELECT });
    });
  }

  async deleteTransaction(id: string, chargeId: string | null): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.paymentTransaction.delete({ where: { id } });
      if (chargeId !== null) await recalcCharge(tx, chargeId);
    });
  }

  // ───────────────────────────── Должники ───────────────────────────────────

  /**
   * Долг по студентам (ТЗ 5.16). Выборка **не постраничная**: место в списке
   * должников зависит от суммы долга, и усечение дало бы тихо неверный итог —
   * то же решение, что с рейтингом (0019, 0024) и статистикой оттока (0025).
   */
  async findDebts(filter: ChargeFilter): Promise<DebtorDebt[]> {
    const groups = await this.prisma.studentPayment.groupBy({
      by: ['studentId'],
      where: { ...chargeWhereOf(filter), remainingAmount: { gt: 0 } },
      _sum: { remainingAmount: true },
      _count: { _all: true },
      _min: { month: true },
    });

    return groups.map(({ studentId, _sum, _count, _min }) => ({
      studentId,
      debtCents: _sum.remainingAmount === null ? 0 : toCents(_sum.remainingAmount),
      unpaidMonths: _count._all,
      oldestUnpaidMonth: _min.month,
    }));
  }

  /** Начислено и оплачено за период — по **всем** месяцам этих студентов. */
  async findChargeTotals(
    filter: ChargeFilter,
    studentIds: string[],
  ): Promise<DebtorChargeTotals[]> {
    if (studentIds.length === 0) return [];

    const groups = await this.prisma.studentPayment.groupBy({
      by: ['studentId'],
      where: { ...chargeWhereOf(filter), studentId: { in: studentIds } },
      _sum: { amount: true, discount: true, paidAmount: true },
    });

    return groups.map(({ studentId, _sum }) => {
      const amount = _sum.amount === null ? 0 : toCents(_sum.amount);
      const discount = _sum.discount === null ? 0 : toCents(_sum.discount);

      return {
        studentId,
        chargedCents: Math.max(0, amount - discount),
        paidCents: _sum.paidAmount === null ? 0 : toCents(_sum.paidAmount),
      };
    });
  }

  /** Принятые вперёд деньги: платежи без месяца (ТЗ 5.16: Prepayment). */
  async findPrepaid(studentIds: string[]): Promise<{ studentId: string; cents: number }[]> {
    if (studentIds.length === 0) return [];

    const groups = await this.prisma.paymentTransaction.groupBy({
      by: ['studentId'],
      where: { studentId: { in: studentIds }, chargeId: null },
      _sum: { amount: true },
    });

    return groups.map(({ studentId, _sum }) => ({
      studentId,
      cents: _sum.amount === null ? 0 : toCents(_sum.amount),
    }));
  }

  async findStudentsByIds(ids: string[]): Promise<StudentProfile[]> {
    if (ids.length === 0) return [];

    return this.prisma.student.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        status: true,
        branch: { select: { id: true, name: true } },
      },
    });
  }

  // ──────────────────────────── Вспомогательное ─────────────────────────────

  findStudentById(id: string): Promise<{ id: string; firstName: string; lastName: string } | null> {
    return this.prisma.student.findUnique({
      where: { id },
      select: { id: true, firstName: true, lastName: true },
    });
  }

  /** Профиль вызывающего — им подписываются начисления и платежи. */
  findEmployeeByAccount(accountId: string): Promise<{ id: string } | null> {
    return this.prisma.employee.findUnique({ where: { accountId }, select: { id: true } });
  }
}

/**
 * Пересчёт принятой суммы и остатка месяца.
 *
 * Именно **пересчёт** (`SUM` по платежам), а не приращение: приращение
 * накапливало бы расхождение на каждой правке и отмене, а его цена здесь —
 * неверный долг, то есть деньги. Выполняется внутри той же транзакции, что
 * и сама запись, — иначе между шагами существовало бы состояние, в котором
 * месяц выглядит оплаченным не на ту сумму.
 */
const recalcCharge = async (tx: Prisma.TransactionClient, chargeId: string): Promise<void> => {
  const charge = await tx.studentPayment.findUniqueOrThrow({
    where: { id: chargeId },
    select: { amount: true, discount: true },
  });

  const sums = await tx.paymentTransaction.aggregate({
    where: { chargeId },
    _sum: { amount: true },
  });

  const paidCents = sums._sum.amount === null ? 0 : toCents(sums._sum.amount);
  const dueCents = dueCentsOf(charge.amount, charge.discount);

  await tx.studentPayment.update({
    where: { id: chargeId },
    data: {
      paidAmount: money(paidCents),
      remainingAmount: money(Math.max(0, dueCents - paidCents)),
    },
  });
};
