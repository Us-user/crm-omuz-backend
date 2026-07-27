import { Injectable } from '@nestjs/common';
import type { AccountStatus, Locale, Prisma, StudentStatus } from '@prisma/client';
import { AccountType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/** Аккаунт в ответах модуля — без хеша пароля: он не должен попадать даже в выборку. */
const ACCOUNT_SELECT = {
  id: true,
  phone: true,
  email: true,
  status: true,
} satisfies Prisma.AccountSelect;

export type StudentAccessAccount = Prisma.AccountGetPayload<{ select: typeof ACCOUNT_SELECT }>;

/**
 * Всё, что нужно, чтобы решить судьбу доступа: профиль, его аккаунт и членства.
 * Членства читаются здесь же — из них выводится статус профиля при разблокировке
 * (`statusAfterUnblock`, ТЗ 5.3).
 */
const STUDENT_ACCESS_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  email: true,
  status: true,
  accountId: true,
  account: { select: ACCOUNT_SELECT },
  groups: { select: { status: true, statusChangedAt: true } },
} satisfies Prisma.StudentSelect;

export type StudentAccessRow = Prisma.StudentGetPayload<{ select: typeof STUDENT_ACCESS_SELECT }>;

export interface SetStudentBlockInput {
  studentId: string;
  /** Статус профиля после действия; `undefined` — оставить как есть. */
  studentStatus?: StudentStatus;
  accountId: string | null;
  /** Статус аккаунта после действия; `undefined` — оставить как есть. */
  accountStatus?: AccountStatus;
  /** Гасить ли живые сессии — при блокировке да, при возврате доступа нечего. */
  revokeSessions: boolean;
}

export interface SetStudentBlockResult {
  account: StudentAccessAccount | null;
  revokedSessions: number;
}

export interface CreateStudentAccountInput {
  studentId: string;
  phone: string;
  email: string;
  /** argon2id-хеш случайного секрета: войти по нему нельзя, пароль задаст студент. */
  passwordHash: string;
  locale: Locale;
  /** Записать ли почту приглашения в карточку студента (если она пришла в теле). */
  updateStudentEmail: boolean;
}

/**
 * Доступ к данным для действий над доступом студента (Invite / Block, ТЗ 5.3).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class StudentAccessRepository {
  constructor(private readonly prisma: PrismaService) {}

  findStudent(id: string): Promise<StudentAccessRow | null> {
    return this.prisma.student.findUnique({ where: { id }, select: STUDENT_ACCESS_SELECT });
  }

  /**
   * Занят ли телефон или email чужим аккаунтом. Оба поля уникальны, и без явной
   * проверки наружу ушёл бы обезличенный `P2002` вместо названной причины.
   */
  findAccountByPhoneOrEmail(
    phone: string,
    email: string,
  ): Promise<{ id: string; phone: string; email: string; type: AccountType } | null> {
    return this.prisma.account.findFirst({
      where: { OR: [{ phone }, { email }] },
      select: { id: true, phone: true, email: true, type: true },
    });
  }

  /**
   * Блокировка и разблокировка одной транзакцией (ТЗ 7).
   *
   * Частичное применение оставило бы либо профиль со статусом `BLOCK` и открытым
   * входом, либо наоборот — состояния, которые выглядят рабочими и расходятся молча.
   */
  async setBlocked(input: SetStudentBlockInput): Promise<SetStudentBlockResult> {
    return this.prisma.$transaction(async (tx) => {
      if (input.studentStatus !== undefined) {
        await tx.student.update({
          where: { id: input.studentId },
          data: { status: input.studentStatus },
        });
      }

      if (input.accountId === null) {
        return { account: null, revokedSessions: 0 };
      }

      const account =
        input.accountStatus === undefined
          ? await tx.account.findUniqueOrThrow({
              where: { id: input.accountId },
              select: ACCOUNT_SELECT,
            })
          : await tx.account.update({
              where: { id: input.accountId },
              data: { status: input.accountStatus },
              select: ACCOUNT_SELECT,
            });

      if (!input.revokeSessions) {
        return { account, revokedSessions: 0 };
      }

      const { count } = await tx.session.updateMany({
        where: { accountId: input.accountId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      return { account, revokedSessions: count };
    });
  }

  /**
   * Выдача логина заведённому профилю одной транзакцией (ТЗ 5.3: Invite).
   *
   * Аккаунт и связь с профилем пишутся вместе: аккаунт без профиля запрещён
   * ТЗ 3.1, а профиль, не узнавший о своём аккаунте, остался бы в списке
   * «кого пригласить» с уже занятым телефоном.
   */
  async createAccount(input: CreateStudentAccountInput): Promise<StudentAccessAccount> {
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.create({
        data: {
          phone: input.phone,
          email: input.email,
          passwordHash: input.passwordHash,
          type: AccountType.STUDENT,
          locale: input.locale,
        },
        select: ACCOUNT_SELECT,
      });

      await tx.student.update({
        where: { id: input.studentId },
        data: {
          accountId: account.id,
          ...(input.updateStudentEmail ? { email: input.email } : {}),
        },
      });

      return account;
    });
  }
}
