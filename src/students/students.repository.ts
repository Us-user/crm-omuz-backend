import { Injectable } from '@nestjs/common';
import type { Gender, Prisma } from '@prisma/client';
import { AccountType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/** Всё, что нужно знать о студенте, чтобы решить и выполнить перевод в сотрудники. */
const STUDENT_PROMOTION_SELECT = {
  id: true,
  accountId: true,
  firstName: true,
  lastName: true,
  birthDate: true,
  gender: true,
  address: true,
  email: true,
  phone: true,
  telegram: true,
  photoUrl: true,
  promotedEmployee: { select: { id: true } },
  account: { select: { id: true, phone: true, email: true, type: true, status: true } },
} satisfies Prisma.StudentSelect;

export type StudentForPromotion = Prisma.StudentGetPayload<{
  select: typeof STUDENT_PROMOTION_SELECT;
}>;

const EMPLOYEE_SELECT = {
  id: true,
  accountId: true,
  formerStudentId: true,
  firstName: true,
  lastName: true,
  middleName: true,
  phone: true,
  email: true,
  status: true,
  hiredAt: true,
} satisfies Prisma.EmployeeSelect;

export type PromotedEmployee = Prisma.EmployeeGetPayload<{ select: typeof EMPLOYEE_SELECT }>;

const ACCOUNT_SELECT = {
  id: true,
  phone: true,
  email: true,
  type: true,
  status: true,
} satisfies Prisma.AccountSelect;

export type PromotedAccount = Prisma.AccountGetPayload<{ select: typeof ACCOUNT_SELECT }>;

/** Поля профиля сотрудника, собранные сервисом из профиля студента и тела запроса. */
export interface PromotedEmployeeInput {
  firstName: string;
  lastName: string;
  middleName?: string;
  birthDate: Date | null;
  gender: Gender | null;
  address: string | null;
  email: string | null;
  phone: string;
  telegram: string | null;
  photoUrl: string | null;
  experience?: string;
  description?: string;
  hiredAt: Date;
}

export interface PromoteStudentInput {
  studentId: string;
  /** Аккаунт студента, если он есть: профиль мог быть заведён администратором без логина. */
  accountId: string | null;
  employee: PromotedEmployeeInput;
}

export interface PromoteStudentResult {
  employee: PromotedEmployee;
  account: PromotedAccount | null;
  revokedSessions: number;
}

/**
 * Доступ к данным студентов (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class StudentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findForPromotion(id: string): Promise<StudentForPromotion | null> {
    return this.prisma.student.findUnique({ where: { id }, select: STUDENT_PROMOTION_SELECT });
  }

  /** Телефон в таблице сотрудников уникален — проверка до вставки, чтобы отдать понятный 409. */
  findEmployeeByPhone(phone: string): Promise<{ id: string } | null> {
    return this.prisma.employee.findUnique({ where: { phone }, select: { id: true } });
  }

  /**
   * Перевод Студент → Сотрудник одной транзакцией (ТЗ 3.1, 7).
   *
   * Частичное применение оставило бы аккаунт без профиля или два профиля на одном
   * аккаунте — оба состояния запрещены ТЗ 3.1 и чинились бы вручную.
   *
   * @returns созданный профиль сотрудника, обновлённый аккаунт и число погашенных сессий.
   */
  async promoteToEmployee(input: PromoteStudentInput): Promise<PromoteStudentResult> {
    return this.prisma.$transaction(async (tx) => {
      // Профиль студента остаётся со всей учебной историей, но отвязывается от
      // аккаунта: ТЗ 3.1 — к аккаунту привязан Student ИЛИ Employee, не одновременно.
      if (input.accountId !== null) {
        await tx.student.update({ where: { id: input.studentId }, data: { accountId: null } });
      }

      const employee = await tx.employee.create({
        data: {
          ...input.employee,
          accountId: input.accountId,
          formerStudentId: input.studentId,
        },
        select: EMPLOYEE_SELECT,
      });

      if (input.accountId === null) {
        return { employee, account: null, revokedSessions: 0 };
      }

      // Логин (`phone`), email и хеш пароля не трогаются — меняется только тип (ТЗ 3.1).
      const account = await tx.account.update({
        where: { id: input.accountId },
        data: { type: AccountType.EMPLOYEE },
        select: ACCOUNT_SELECT,
      });

      // Тип аккаунта зашит в access-токен, а стратегия не ходит в БД: без гашения
      // сессий бывший студент до часа ходил бы с токеном типа STUDENT.
      const { count } = await tx.session.updateMany({
        where: { accountId: input.accountId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      return { employee, account, revokedSessions: count };
    });
  }
}
