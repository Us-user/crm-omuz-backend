import { Injectable } from '@nestjs/common';
import type { CoinSource, Prisma } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { CoinSortField } from './dto';

/** Строка истории вместе с автором и неделей: список читают именами, а не идентификаторами. */
const COIN_TRANSACTION_SELECT = {
  id: true,
  studentId: true,
  amount: true,
  reason: true,
  source: true,
  createdAt: true,
  author: { select: { id: true, firstName: true, lastName: true } },
  week: { select: { id: true, groupId: true, weekNumber: true } },
} satisfies Prisma.CoinTransactionSelect;

export type CoinTransactionRow = Prisma.CoinTransactionGetPayload<{
  select: typeof COIN_TRANSACTION_SELECT;
}>;

export interface CoinListParams {
  studentId: string;
  source?: CoinSource;
  sort: CoinSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface AwardCoinsInput {
  studentId: string;
  amount: number;
  reason: string;
  source: CoinSource;
  /** Сотрудник, начисливший вручную; `null` — у аккаунта нет профиля сотрудника. */
  authorId: string | null;
}

/**
 * Доступ к данным коинов (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class StudentCoinsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: CoinListParams): Promise<{ rows: CoinTransactionRow[]; total: number }> {
    const where: Prisma.CoinTransactionWhereInput = {
      studentId: params.studentId,
      ...(params.source === undefined ? {} : { source: params.source }),
    };

    const orderBy: Prisma.CoinTransactionOrderByWithRelationInput =
      params.sort === CoinSortField.Amount ? { amount: params.order } : { createdAt: params.order };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.coinTransaction.findMany({
        where,
        select: COIN_TRANSACTION_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.coinTransaction.count({ where }),
    ]);

    return { rows, total };
  }

  /** Есть ли такой студент: коины несуществующего человека — это 404, а не пустая история. */
  findStudent(id: string): Promise<{ id: string; firstName: string; lastName: string } | null> {
    return this.prisma.student.findUnique({
      where: { id },
      select: { id: true, firstName: true, lastName: true },
    });
  }

  /** Профиль сотрудника по его аккаунту — автор начисления (ТЗ 5.14: логин опционален). */
  findEmployeeByAccount(accountId: string): Promise<{ id: string } | null> {
    return this.prisma.employee.findUnique({ where: { accountId }, select: { id: true } });
  }

  /**
   * Баланс студента. Строки может не быть: она заводится первым начислением,
   * а до него баланс — честный ноль, а не отсутствующее значение.
   */
  async findBalance(studentId: string): Promise<number> {
    const balance = await this.prisma.coinBalance.findUnique({
      where: { studentId },
      select: { balance: true },
    });

    return balance?.balance ?? 0;
  }

  /**
   * Начисление одной транзакцией: строка истории + баланс (ТЗ 7).
   *
   * Раздельная запись оставила бы либо историю без баланса, либо баланс без
   * объяснения, откуда он взялся, — а списания в системе нет (ТЗ 5.9), значит
   * поправить расхождение было бы нечем.
   */
  award(input: AwardCoinsInput): Promise<{ row: CoinTransactionRow; balance: number }> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.coinTransaction.create({
        data: {
          studentId: input.studentId,
          amount: input.amount,
          reason: input.reason,
          source: input.source,
          authorId: input.authorId,
        },
        select: COIN_TRANSACTION_SELECT,
      });

      const balance = await tx.coinBalance.upsert({
        where: { studentId: input.studentId },
        create: { studentId: input.studentId, balance: input.amount },
        update: { balance: { increment: input.amount } },
        select: { balance: true },
      });

      return { row, balance: balance.balance };
    });
  }
}
