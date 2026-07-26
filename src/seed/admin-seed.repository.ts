import { Injectable } from '@nestjs/common';
import { AccountType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

export interface ExistingAccount {
  id: string;
  phone: string;
  email: string;
  type: AccountType;
  employee: { id: string; positionIds: string[] } | null;
}

export interface CreateAdminInput {
  phone: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
  positionId: string;
}

export interface CreatedAdmin {
  accountId: string;
  employeeId: string;
}

/**
 * Запросы сид-скрипта первого руководителя. Отдельный репозиторий, а не запросы
 * прямо в скрипте: сценарий один раз пишет сразу в три таблицы, и правила выбора
 * («кого считать уже заведённым») стоит проверять тестом.
 */
@Injectable()
export class AdminSeedRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAccountByPhone(phone: string): Promise<ExistingAccount | null> {
    const account = await this.prisma.account.findUnique({
      where: { phone },
      select: {
        id: true,
        phone: true,
        email: true,
        type: true,
        employee: { select: { id: true, positions: { select: { positionId: true } } } },
      },
    });

    if (!account) return null;

    return {
      ...account,
      employee: account.employee
        ? {
            id: account.employee.id,
            positionIds: account.employee.positions.map(({ positionId }) => positionId),
          }
        : null,
    };
  }

  findAccountIdByEmail(email: string): Promise<{ id: string } | null> {
    return this.prisma.account.findUnique({ where: { email }, select: { id: true } });
  }

  findPositionByName(name: string): Promise<{ id: string } | null> {
    return this.prisma.position.findUnique({ where: { name }, select: { id: true } });
  }

  /** Телефон сотрудника уникален отдельно от логина — проверяется до вставки. */
  findEmployeeIdByPhone(phone: string): Promise<{ id: string } | null> {
    return this.prisma.employee.findUnique({ where: { phone }, select: { id: true } });
  }

  /**
   * Аккаунт, профиль сотрудника и назначение позиции — одной транзакцией.
   * Частично применённый сид оставил бы либо логин без профиля, либо
   * руководителя без прав: и то и другое чинится только руками в БД.
   */
  async createDirector(input: CreateAdminInput): Promise<CreatedAdmin> {
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.create({
        data: {
          phone: input.phone,
          email: input.email,
          passwordHash: input.passwordHash,
          type: AccountType.EMPLOYEE,
        },
        select: { id: true },
      });

      const employee = await tx.employee.create({
        data: {
          accountId: account.id,
          firstName: input.firstName,
          lastName: input.lastName,
          middleName: input.middleName,
          phone: input.phone,
          email: input.email,
          hiredAt: new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z'),
        },
        select: { id: true },
      });

      await tx.employeePosition.create({
        data: { employeeId: employee.id, positionId: input.positionId },
      });

      return { accountId: account.id, employeeId: employee.id };
    });
  }

  async assignPosition(employeeId: string, positionId: string): Promise<void> {
    await this.prisma.employeePosition.create({ data: { employeeId, positionId } });
  }
}
