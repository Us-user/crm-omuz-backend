import { Injectable } from '@nestjs/common';
import type { Locale, PasswordResetCode, Prisma, Session } from '@prisma/client';
import { AccountType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/** Поля аккаунта, нужные аутентификации, вместе с краткой карточкой профиля. */
const ACCOUNT_SELECT = {
  id: true,
  phone: true,
  email: true,
  passwordHash: true,
  type: true,
  status: true,
  locale: true,
  student: { select: { id: true, firstName: true, lastName: true } },
  employee: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.AccountSelect;

export type AccountWithProfile = Prisma.AccountGetPayload<{ select: typeof ACCOUNT_SELECT }>;

/** Данные для создания аккаунта студента при регистрации. */
export interface CreateStudentAccountInput {
  phone: string;
  email: string;
  passwordHash: string;
  locale: Locale;
  firstName: string;
  lastName: string;
  birthDate: Date;
  address: string;
  /** Телефон родителя из формы регистрации (ТЗ 3.1), уже приведённый к E.164. */
  parentPhone?: string;
}

export interface CreateSessionInput {
  /** Задаётся приложением: идентификатор попадает в токен ещё до записи строки. */
  id: string;
  accountId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  userAgent?: string;
  ip?: string;
}

export type RotateSessionInput = Omit<CreateSessionInput, 'id' | 'accountId'>;

export interface CreatePasswordResetCodeInput {
  accountId: string;
  /** argon2id-хеш кода: сам код в БД не попадает. */
  codeHash: string;
  expiresAt: Date;
}

export interface CompletePasswordResetInput {
  accountId: string;
  codeId: string;
  passwordHash: string;
}

/**
 * Доступ к данным Auth (`Controller → Service → Repository`).
 * Здесь нет бизнес-правил — только запросы к Prisma.
 */
@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAccountByPhone(phone: string): Promise<AccountWithProfile | null> {
    return this.prisma.account.findUnique({ where: { phone }, select: ACCOUNT_SELECT });
  }

  findAccountById(id: string): Promise<AccountWithProfile | null> {
    return this.prisma.account.findUnique({ where: { id }, select: ACCOUNT_SELECT });
  }

  /** Поиск по email — точка входа сброса пароля (ТЗ 5.1). */
  findAccountByEmail(email: string): Promise<AccountWithProfile | null> {
    return this.prisma.account.findUnique({ where: { email }, select: ACCOUNT_SELECT });
  }

  /** Есть ли аккаунт с таким телефоном или email — проверка до создания (409). */
  findAccountByPhoneOrEmail(
    phone: string,
    email: string,
  ): Promise<{ phone: string; email: string } | null> {
    return this.prisma.account.findFirst({
      where: { OR: [{ phone }, { email }] },
      select: { phone: true, email: true },
    });
  }

  /** Профиль студента с таким контактным телефоном (телефон уникален в таблице). */
  findStudentByPhone(phone: string): Promise<{ id: string } | null> {
    return this.prisma.student.findUnique({ where: { phone }, select: { id: true } });
  }

  /**
   * Создаёт аккаунт и профиль студента одной транзакцией: аккаунт без профиля —
   * невалидное состояние (ТЗ 3.1). Вложенные записи Prisma выполняет в одной
   * транзакции, поэтому родитель заводится здесь же.
   *
   * Телефон родителя (ТЗ 3.1) больше не колонка профиля, а запись `Parent`
   * (ТЗ 4): `connectOrCreate` привязывает уже существующего родителя, если
   * такой номер в системе есть, — например, когда регистрируется второй ребёнок
   * той же семьи. Имя и степень родства остаются пустыми: форма регистрации
   * их не спрашивает, и подставленное значение было бы выдумкой.
   */
  async createStudentAccount(input: CreateStudentAccountInput): Promise<AccountWithProfile> {
    return this.prisma.account.create({
      data: {
        phone: input.phone,
        email: input.email,
        passwordHash: input.passwordHash,
        type: AccountType.STUDENT,
        locale: input.locale,
        student: {
          create: {
            firstName: input.firstName,
            lastName: input.lastName,
            birthDate: input.birthDate,
            address: input.address,
            email: input.email,
            phone: input.phone,
            ...(input.parentPhone === undefined
              ? {}
              : {
                  parents: {
                    create: {
                      parent: {
                        connectOrCreate: {
                          where: { phone: input.parentPhone },
                          create: { phone: input.parentPhone },
                        },
                      },
                    },
                  },
                }),
          },
        },
      },
      select: ACCOUNT_SELECT,
    });
  }

  async touchLastLogin(accountId: string): Promise<void> {
    await this.prisma.account.update({
      where: { id: accountId },
      data: { lastLoginAt: new Date() },
    });
  }

  createSession(input: CreateSessionInput): Promise<Session> {
    return this.prisma.session.create({ data: input });
  }

  findSessionById(id: string): Promise<Session | null> {
    return this.prisma.session.findUnique({ where: { id } });
  }

  /**
   * Ротация: в существующую строку кладётся отпечаток нового refresh-токена,
   * поэтому предыдущий токен перестаёт подходить (ТЗ 3.1).
   * Заодно обновляются признаки клиента — устройство одно, но IP мог смениться.
   */
  async rotateSession(id: string, input: RotateSessionInput): Promise<void> {
    await this.prisma.session.update({
      where: { id },
      data: {
        refreshTokenHash: input.refreshTokenHash,
        expiresAt: input.expiresAt,
        userAgent: input.userAgent,
        ip: input.ip,
        lastUsedAt: new Date(),
      },
    });
  }

  /** Гасит одну сессию. Возвращает `false`, если она уже была погашена. */
  async revokeSession(id: string): Promise<boolean> {
    const { count } = await this.prisma.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count > 0;
  }

  /** «Выйти со всех устройств» — гасит все живые сессии аккаунта. */
  async revokeAllSessions(accountId: string): Promise<number> {
    const { count } = await this.prisma.session.updateMany({
      where: { accountId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  }

  // --- Сброс пароля (ТЗ 3.1, 5.1) ---

  /** Сколько кодов аккаунт запросил начиная с `since` — основа лимита «3 в час». */
  countPasswordResetCodesSince(accountId: string, since: Date): Promise<number> {
    return this.prisma.passwordResetCode.count({
      where: { accountId, createdAt: { gte: since } },
    });
  }

  createPasswordResetCode(input: CreatePasswordResetCodeInput): Promise<PasswordResetCode> {
    return this.prisma.passwordResetCode.create({ data: input });
  }

  /**
   * Живой код аккаунта: не использован и не просрочен. Берётся самый свежий —
   * предыдущие гасятся при выпуске нового, но выборка от них не зависит.
   */
  findActivePasswordResetCode(accountId: string, now: Date): Promise<PasswordResetCode | null> {
    return this.prisma.passwordResetCode.findFirst({
      where: { accountId, consumedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Гасит все живые коды аккаунта: новый код должен оставаться единственным. */
  async consumeActivePasswordResetCodes(accountId: string): Promise<number> {
    const { count } = await this.prisma.passwordResetCode.updateMany({
      where: { accountId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return count;
  }

  /** Отмечает неудачную попытку ввода; `consume` гасит код на исчерпании лимита. */
  async registerPasswordResetAttempt(codeId: string, consume: boolean): Promise<void> {
    await this.prisma.passwordResetCode.update({
      where: { id: codeId },
      data: {
        attempts: { increment: 1 },
        ...(consume ? { consumedAt: new Date() } : {}),
      },
    });
  }

  /**
   * Смена пароля одной транзакцией (ТЗ 7): код гасится, пароль меняется,
   * все сессии отзываются. Частичное применение оставило бы либо действующий
   * код, либо живые сессии со старым паролем.
   *
   * @returns число погашенных сессий.
   */
  async completePasswordReset(input: CompletePasswordResetInput): Promise<number> {
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      await tx.passwordResetCode.update({
        where: { id: input.codeId },
        data: { consumedAt: now },
      });

      await tx.account.update({
        where: { id: input.accountId },
        data: { passwordHash: input.passwordHash },
      });

      const { count } = await tx.session.updateMany({
        where: { accountId: input.accountId, revokedAt: null },
        data: { revokedAt: now },
      });

      return count;
    });
  }
}
