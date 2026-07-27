import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { PasswordResetCode, Session } from '@prisma/client';
import {
  AccountStatus,
  AccountType,
  GroupStudentStatus,
  Locale,
  StudentStatus,
} from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import type {
  AccountWithProfile,
  CompletePasswordResetInput,
  CreatePasswordResetCodeInput,
  CreateSessionInput,
  RotateSessionInput,
} from 'src/auth/auth.repository';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { LoggerModule } from 'src/logger/logger.module';
import type { MailMessage } from 'src/mailer';
import { MailerService } from 'src/mailer';
import { MailerModule } from 'src/mailer/mailer.module';
import { PhoneModule } from 'src/phone/phone.module';
import { RbacModule } from 'src/rbac/rbac.module';
import { RbacRepository } from 'src/rbac/rbac.repository';
import type {
  CreateStudentAccountInput,
  SetStudentBlockInput,
  SetStudentBlockResult,
  StudentAccessAccount,
  StudentAccessRow,
} from 'src/student-access/student-access.repository';
import { StudentAccessRepository } from 'src/student-access/student-access.repository';
import { StudentAccessModule } from 'src/student-access/student-access.module';
import { buildOpenApiDocument } from 'src/swagger';

/** `{ data }` ответа с ожидаемым типом — тела supertest типизированы как `any`. */
const dataOf = <T>(response: { body: unknown }): T => (response.body as { data: T }).data;

/** Права аккаунта в памяти вместо трёх таблиц RBAC (как в остальных наборах). */
class InMemoryRbacRepository {
  private readonly codesByAccount = new Map<string, string[]>();

  grant(accountId: string, codes: string[]): void {
    this.codesByAccount.set(accountId, codes);
  }

  findAccountPermissionCodes(accountId: string): Promise<{ code: string }[]> {
    return Promise.resolve((this.codesByAccount.get(accountId) ?? []).map((code) => ({ code })));
  }

  findAllPermissions(): Promise<[]> {
    return Promise.resolve([]);
  }

  createPermissions(): Promise<number> {
    return Promise.resolve(0);
  }

  updatePermission(): Promise<void> {
    return Promise.resolve();
  }

  syncSystemPosition(): Promise<number> {
    return Promise.resolve(0);
  }
}

interface StoredAccount extends AccountWithProfile {
  lastLoginAt: Date | null;
}

/**
 * Студенты, аккаунты, сессии и коды сброса — в одном хранилище.
 *
 * Разделять их нельзя: главный сценарий набора («пригласили → студент прочитал
 * письмо → задал пароль публичным `POST /auth/password/reset` → вошёл») проходит
 * через **оба** репозитория, и две несогласованные заглушки проверяли бы
 * не то поведение, которое даёт БД.
 */
class InMemoryAccessStore {
  readonly students = new Map<string, StudentAccessRow>();
  readonly accounts = new Map<string, StoredAccount>();
  readonly sessions = new Map<string, Session>();
  private readonly resetCodes = new Map<string, PasswordResetCode>();

  addStudent(overrides: Partial<StudentAccessRow> = {}): StudentAccessRow {
    const index = this.students.size + 1;
    const student: StudentAccessRow = {
      id: randomUUID(),
      firstName: 'Нигина',
      lastName: `Каримова-${String(index)}`,
      phone: `+99290123456${String(index)}`,
      email: `nigina${String(index)}@mail.tj`,
      status: StudentStatus.ACTIVE,
      accountId: null,
      account: null,
      groups: [],
      ...overrides,
    };
    this.students.set(student.id, student);

    return student;
  }

  /** Готовый аккаунт студента — для случаев «уже приглашён». */
  addAccount(student: StudentAccessRow, overrides: Partial<StoredAccount> = {}): StoredAccount {
    const account: StoredAccount = {
      id: randomUUID(),
      phone: student.phone,
      email: student.email ?? `${student.id}@mail.tj`,
      passwordHash: '$argon2id$existing',
      type: AccountType.STUDENT,
      status: AccountStatus.ACTIVE,
      locale: Locale.RU,
      lastLoginAt: null,
      student: { id: student.id, firstName: student.firstName, lastName: student.lastName },
      employee: null,
      ...overrides,
    };

    this.accounts.set(account.id, account);
    student.accountId = account.id;
    student.account = pickAccount(account);

    return account;
  }

  /** Аккаунт постороннего человека — для проверок «логин занят». */
  addForeignAccount(phone: string, email: string, type: AccountType): StoredAccount {
    const account: StoredAccount = {
      id: randomUUID(),
      phone,
      email,
      passwordHash: '$argon2id$foreign',
      type,
      status: AccountStatus.ACTIVE,
      locale: Locale.RU,
      lastLoginAt: null,
      student: null,
      employee: null,
    };
    this.accounts.set(account.id, account);

    return account;
  }

  enroll(
    student: StudentAccessRow,
    status: GroupStudentStatus,
    statusChangedAt: Date | null,
  ): void {
    student.groups.push({ status, statusChangedAt });
  }

  liveSessions(accountId: string): number {
    return [...this.sessions.values()].filter(
      (session) => session.accountId === accountId && session.revokedAt === null,
    ).length;
  }

  // ─── StudentAccessRepository ───

  findStudent(id: string): Promise<StudentAccessRow | null> {
    return Promise.resolve(this.students.get(id) ?? null);
  }

  findAccountByPhoneOrEmail(
    phone: string,
    email: string,
  ): Promise<{ id: string; phone: string; email: string; type: AccountType } | null> {
    const found = [...this.accounts.values()].find((a) => a.phone === phone || a.email === email);

    return Promise.resolve(
      found ? { id: found.id, phone: found.phone, email: found.email, type: found.type } : null,
    );
  }

  setBlocked(input: SetStudentBlockInput): Promise<SetStudentBlockResult> {
    const student = this.students.get(input.studentId);
    if (!student) throw new Error('Студента нет: тест построен неверно');

    if (input.studentStatus !== undefined) student.status = input.studentStatus;

    if (input.accountId === null) {
      return Promise.resolve({ account: null, revokedSessions: 0 });
    }

    const account = this.accounts.get(input.accountId);
    if (!account) throw new Error('Аккаунта нет: тест построен неверно');

    if (input.accountStatus !== undefined) account.status = input.accountStatus;
    student.account = pickAccount(account);

    if (!input.revokeSessions) {
      return Promise.resolve({ account: pickAccount(account), revokedSessions: 0 });
    }

    let revoked = 0;
    for (const session of this.sessions.values()) {
      if (session.accountId === account.id && session.revokedAt === null) {
        session.revokedAt = new Date();
        revoked += 1;
      }
    }

    return Promise.resolve({ account: pickAccount(account), revokedSessions: revoked });
  }

  createAccount(input: CreateStudentAccountInput): Promise<StudentAccessAccount> {
    const student = this.students.get(input.studentId);
    if (!student) throw new Error('Студента нет: тест построен неверно');

    const account: StoredAccount = {
      id: randomUUID(),
      phone: input.phone,
      email: input.email,
      passwordHash: input.passwordHash,
      type: AccountType.STUDENT,
      status: AccountStatus.ACTIVE,
      locale: input.locale,
      lastLoginAt: null,
      student: { id: student.id, firstName: student.firstName, lastName: student.lastName },
      employee: null,
    };

    this.accounts.set(account.id, account);
    student.accountId = account.id;
    student.account = pickAccount(account);
    if (input.updateStudentEmail) student.email = input.email;

    return Promise.resolve(pickAccount(account));
  }

  // ─── AuthRepository (вход и сброс пароля) ───

  findAccountByPhone(phone: string): Promise<AccountWithProfile | null> {
    return Promise.resolve([...this.accounts.values()].find((a) => a.phone === phone) ?? null);
  }

  findAccountByEmail(email: string): Promise<AccountWithProfile | null> {
    return Promise.resolve([...this.accounts.values()].find((a) => a.email === email) ?? null);
  }

  findAccountById(id: string): Promise<AccountWithProfile | null> {
    return Promise.resolve(this.accounts.get(id) ?? null);
  }

  touchLastLogin(accountId: string): Promise<void> {
    const account = this.accounts.get(accountId);
    if (account) account.lastLoginAt = new Date();

    return Promise.resolve();
  }

  createSession(input: CreateSessionInput): Promise<Session> {
    const session: Session = {
      id: input.id,
      accountId: input.accountId,
      refreshTokenHash: input.refreshTokenHash,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
      expiresAt: input.expiresAt,
      revokedAt: null,
      lastUsedAt: new Date(),
      createdAt: new Date(),
    };
    this.sessions.set(session.id, session);

    return Promise.resolve(session);
  }

  findSessionById(id: string): Promise<Session | null> {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }

  rotateSession(id: string, input: RotateSessionInput): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      Object.assign(session, {
        refreshTokenHash: input.refreshTokenHash,
        expiresAt: input.expiresAt,
        lastUsedAt: new Date(),
      });
    }

    return Promise.resolve();
  }

  revokeSession(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session || session.revokedAt !== null) return Promise.resolve(false);
    session.revokedAt = new Date();

    return Promise.resolve(true);
  }

  revokeAllSessions(accountId: string): Promise<number> {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.accountId === accountId && session.revokedAt === null) {
        session.revokedAt = new Date();
        count += 1;
      }
    }

    return Promise.resolve(count);
  }

  countPasswordResetCodesSince(accountId: string, since: Date): Promise<number> {
    return Promise.resolve(
      [...this.resetCodes.values()].filter(
        (code) => code.accountId === accountId && code.createdAt >= since,
      ).length,
    );
  }

  createPasswordResetCode(input: CreatePasswordResetCodeInput): Promise<PasswordResetCode> {
    const code: PasswordResetCode = {
      id: randomUUID(),
      accountId: input.accountId,
      codeHash: input.codeHash,
      attempts: 0,
      expiresAt: input.expiresAt,
      consumedAt: null,
      createdAt: new Date(),
    };
    this.resetCodes.set(code.id, code);

    return Promise.resolve(code);
  }

  findActivePasswordResetCode(accountId: string, now: Date): Promise<PasswordResetCode | null> {
    const found = [...this.resetCodes.values()]
      .filter(
        (code) => code.accountId === accountId && code.consumedAt === null && code.expiresAt > now,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return Promise.resolve(found[0] ?? null);
  }

  consumeActivePasswordResetCodes(accountId: string): Promise<number> {
    let count = 0;
    for (const code of this.resetCodes.values()) {
      if (code.accountId === accountId && code.consumedAt === null) {
        code.consumedAt = new Date();
        count += 1;
      }
    }

    return Promise.resolve(count);
  }

  registerPasswordResetAttempt(codeId: string, consume: boolean): Promise<void> {
    const code = this.resetCodes.get(codeId);
    if (code) {
      code.attempts += 1;
      if (consume) code.consumedAt = new Date();
    }

    return Promise.resolve();
  }

  completePasswordReset(input: CompletePasswordResetInput): Promise<number> {
    const code = this.resetCodes.get(input.codeId);
    if (code) code.consumedAt = new Date();

    const account = this.accounts.get(input.accountId);
    if (account) account.passwordHash = input.passwordHash;

    return this.revokeAllSessions(input.accountId);
  }
}

const pickAccount = (account: StoredAccount): StudentAccessAccount => ({
  id: account.id,
  phone: account.phone,
  email: account.email,
  status: account.status,
});

/** Перехватывает письма вместо провайдера — код читается так же, как студентом. */
class RecordingMailer extends MailerService {
  readonly sent: MailMessage[] = [];

  override send(message: MailMessage): Promise<void> {
    this.sent.push(message);

    return Promise.resolve();
  }

  lastCode(): string {
    const last = this.sent.at(-1);
    const found = last ? /\b(\d{6})\b/.exec(last.text) : null;
    if (!found) throw new Error('В последнем письме нет шестизначного кода');

    return found[1];
  }
}

interface BlockedBody {
  id: string;
  fullName: string;
  blocked: boolean;
  status: StudentStatus;
  account: { id: string; phone: string; email: string; status: AccountStatus } | null;
  revokedSessions: number;
}

interface InvitedBody {
  id: string;
  fullName: string;
  account: { id: string; phone: string; email: string; status: AccountStatus };
  codeSentTo: string;
}

describe('Студенты: доступ — Invite и Block (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryAccessStore;
  let rbac: InMemoryRbacRepository;
  let mailer: RecordingMailer;
  let tokens: TokenService;

  beforeEach(async () => {
    store = new InMemoryAccessStore();
    rbac = new InMemoryRbacRepository();
    mailer = new RecordingMailer();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        PhoneModule,
        AuthModule,
        RbacModule,
        StudentAccessModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
      ],
    })
      // Один и тот же store за обоими репозиториями: приглашение создаёт аккаунт,
      // а пароль по коду задаётся публичным маршрутом Auth — они обязаны видеть
      // одни и те же данные.
      .overrideProvider(AuthRepository)
      .useValue(store)
      .overrideProvider(StudentAccessRepository)
      .useValue(store)
      .overrideProvider(RbacRepository)
      .useValue(rbac)
      .overrideProvider(MailerService)
      .useValue(mailer)
      .compile();

    tokens = moduleRef.get(TokenService, { strict: false });

    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  const actor = async (...codes: string[]): Promise<string> => {
    const accountId = randomUUID();
    rbac.grant(accountId, codes);

    return (
      await tokens.issuePair({ sub: accountId, sid: randomUUID(), type: AccountType.EMPLOYEE })
    ).accessToken;
  };

  const studentToken = async (): Promise<string> =>
    (await tokens.issuePair({ sub: randomUUID(), sid: randomUUID(), type: AccountType.STUDENT }))
      .accessToken;

  const post = (url: string, token: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${token}`).send(body);

  const anonymous = (url: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).post(url).send(body);

  describe('Доступ к действиям', () => {
    it('без токена — 401', async () => {
      const student = store.addStudent();

      await request(app.getHttpServer())
        .post(`/api/v1/students/${student.id}/block`)
        .send({ blocked: true })
        .expect(401);
    });

    it('студент себя не разблокирует — 403 (ТЗ 3.2)', async () => {
      const student = store.addStudent();

      await post(`/api/v1/students/${student.id}/block`, await studentToken(), {
        blocked: false,
      }).expect(403);
    });

    it('сотрудник без прав — 403', async () => {
      const student = store.addStudent();

      await post(`/api/v1/students/${student.id}/block`, await actor(), { blocked: true }).expect(
        403,
      );
    });

    it('право на правку карточки блокировку не открывает', async () => {
      const student = store.addStudent();

      await post(
        `/api/v1/students/${student.id}/block`,
        await actor('Permission.Students.Update'),
        {
          blocked: true,
        },
      ).expect(403);
    });

    it('право на блокировку не даёт приглашать', async () => {
      const student = store.addStudent();

      await post(
        `/api/v1/students/${student.id}/invite`,
        await actor('Permission.Students.Block'),
      ).expect(403);
    });
  });

  describe('Блокировка (ТЗ 5.3: блок входа, обратимо)', () => {
    it('закрывает вход и профилю, и аккаунту', async () => {
      const student = store.addStudent();
      store.addAccount(student);

      const response = await post(
        `/api/v1/students/${student.id}/block`,
        await actor('Permission.Students.Block'),
        { blocked: true },
      ).expect(200);

      expect(dataOf<BlockedBody>(response)).toMatchObject({
        blocked: true,
        status: StudentStatus.BLOCK,
        account: { status: AccountStatus.BLOCKED },
      });
    });

    it('заблокированный больше не обновляет токены', async () => {
      const student = store.addStudent();
      const account = store.addAccount(student);

      // Живая сессия — как после входа.
      const pair = await tokens.issuePair({
        sub: account.id,
        sid: randomUUID(),
        type: AccountType.STUDENT,
      });
      const { sid } = await tokens.verifyRefresh(pair.refreshToken);
      await store.createSession({
        id: sid,
        accountId: account.id,
        refreshTokenHash: tokens.fingerprint(pair.refreshToken),
        expiresAt: pair.refreshExpiresAt,
      });

      await anonymous('/api/v1/auth/refresh', { refreshToken: pair.refreshToken }).expect(200);

      await post(`/api/v1/students/${student.id}/block`, await actor('Permission.Students.Block'), {
        blocked: true,
      }).expect(200);

      expect(store.liveSessions(account.id)).toBe(0);
    });

    it('студент без логина блокируется тоже — блокируется профиль', async () => {
      const student = store.addStudent();

      const response = await post(
        `/api/v1/students/${student.id}/block`,
        await actor('Permission.Students.Block'),
        { blocked: true },
      ).expect(200);

      expect(dataOf<BlockedBody>(response)).toMatchObject({
        blocked: true,
        status: StudentStatus.BLOCK,
        account: null,
        revokedSessions: 0,
      });
    });

    it('разблокировка возвращает статус учащегося', async () => {
      const student = store.addStudent({ status: StudentStatus.BLOCK });
      store.addAccount(student, { status: AccountStatus.BLOCKED });
      store.enroll(student, GroupStudentStatus.ACTIVE, null);

      const response = await post(
        `/api/v1/students/${student.id}/block`,
        await actor('Permission.Students.Block'),
        { blocked: false },
      ).expect(200);

      expect(dataOf<BlockedBody>(response)).toMatchObject({
        blocked: false,
        status: StudentStatus.ACTIVE,
        account: { status: AccountStatus.ACTIVE },
      });
    });

    it('покинувшего курс разблокировка возвращает в «No Active» (ТЗ 5.12)', async () => {
      const student = store.addStudent({ status: StudentStatus.BLOCK });
      store.enroll(student, GroupStudentStatus.LEFT, new Date('2026-05-01T00:00:00.000Z'));

      const response = await post(
        `/api/v1/students/${student.id}/block`,
        await actor('Permission.Students.Block'),
        { blocked: false },
      ).expect(200);

      expect(dataOf<BlockedBody>(response).status).toBe(StudentStatus.NO_ACTIVE);
    });

    it('блокировка и разблокировка обратимы по кругу', async () => {
      const student = store.addStudent();
      store.addAccount(student);
      const token = await actor('Permission.Students.Block');
      const url = `/api/v1/students/${student.id}/block`;

      await post(url, token, { blocked: true }).expect(200);
      await post(url, token, { blocked: false }).expect(200);
      const again = await post(url, token, { blocked: true }).expect(200);

      expect(dataOf<BlockedBody>(again)).toMatchObject({
        blocked: true,
        status: StudentStatus.BLOCK,
      });
    });

    it('400 без поля blocked и на лишнее поле', async () => {
      const student = store.addStudent();
      const token = await actor('Permission.Students.Block');

      await post(`/api/v1/students/${student.id}/block`, token, {}).expect(400);
      await post(`/api/v1/students/${student.id}/block`, token, {
        blocked: true,
        reason: 'мешал',
      }).expect(400);
    });

    it('404 на неизвестного студента, 400 на не-UUID в пути', async () => {
      const token = await actor('Permission.Students.Block');

      await post(`/api/v1/students/${randomUUID()}/block`, token, { blocked: true }).expect(404);
      await post('/api/v1/students/не-uuid/block', token, { blocked: true }).expect(400);
    });
  });

  describe('Приглашение (ТЗ 5.3: Invite)', () => {
    it('выдаёт логин-телефон и шлёт код на почту карточки', async () => {
      const student = store.addStudent({ email: 'nigina@mail.tj' });

      const response = await post(
        `/api/v1/students/${student.id}/invite`,
        await actor('Permission.Students.Invite'),
      ).expect(201);

      const body = dataOf<InvitedBody>(response);
      expect(body).toMatchObject({
        fullName: `${student.lastName} ${student.firstName}`,
        account: { phone: student.phone, email: 'nigina@mail.tj', status: AccountStatus.ACTIVE },
        codeSentTo: 'nigina@mail.tj',
      });
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]?.text).toContain(student.phone);
    });

    it('пароль наружу не отдаётся ни в каком виде', async () => {
      const student = store.addStudent();

      const response = await post(
        `/api/v1/students/${student.id}/invite`,
        await actor('Permission.Students.Invite'),
      ).expect(201);

      expect(JSON.stringify(response.body)).not.toContain('password');
    });

    it('приглашённый задаёт пароль по коду и входит (полный путь)', async () => {
      const student = store.addStudent({ email: 'nigina@mail.tj' });

      await post(
        `/api/v1/students/${student.id}/invite`,
        await actor('Permission.Students.Invite'),
      ).expect(201);

      await anonymous('/api/v1/auth/password/reset', {
        email: 'nigina@mail.tj',
        code: mailer.lastCode(),
        newPassword: 'очень-секретный-пароль',
      }).expect(200);

      const login = await anonymous('/api/v1/auth/login', {
        phone: student.phone,
        password: 'очень-секретный-пароль',
      }).expect(200);

      expect(
        dataOf<{ account: { id: string }; tokens: { accessToken: string } }>(login),
      ).toMatchObject({
        account: { id: store.students.get(student.id)?.accountId, type: AccountType.STUDENT },
        tokens: { accessToken: expect.any(String) as string },
      });
    }, 30_000);

    it('письмо уходит на языке из запроса (ТЗ 3.3)', async () => {
      const student = store.addStudent();

      await post(
        `/api/v1/students/${student.id}/invite`,
        await actor('Permission.Students.Invite'),
        {
          locale: Locale.EN,
        },
      ).expect(201);

      expect(mailer.sent[0]?.subject).toContain('access');
    });

    it('почта из тела становится логином и попадает в карточку', async () => {
      const student = store.addStudent({ email: null });

      const response = await post(
        `/api/v1/students/${student.id}/invite`,
        await actor('Permission.Students.Invite'),
        { email: 'Nigina@Mail.TJ' },
      ).expect(201);

      expect(dataOf<InvitedBody>(response).account.email).toBe('nigina@mail.tj');
      expect(store.students.get(student.id)?.email).toBe('nigina@mail.tj');
    });

    it('422 без почты: приглашение отправляется письмом', async () => {
      const student = store.addStudent({ email: null });

      await post(
        `/api/v1/students/${student.id}/invite`,
        await actor('Permission.Students.Invite'),
      ).expect(422);
      expect(mailer.sent).toHaveLength(0);
    });

    it('409 на повторное приглашение — логин уже есть', async () => {
      const student = store.addStudent();
      store.addAccount(student);

      await post(
        `/api/v1/students/${student.id}/invite`,
        await actor('Permission.Students.Invite'),
      ).expect(409);
    });

    it('409, если телефон уже логин сотрудника', async () => {
      const student = store.addStudent();
      store.addForeignAccount(student.phone, 'employee@omuz.tj', AccountType.EMPLOYEE);

      await post(
        `/api/v1/students/${student.id}/invite`,
        await actor('Permission.Students.Invite'),
      ).expect(409);
      expect(store.students.get(student.id)?.accountId).toBeNull();
    });

    it('409, если почта занята другим аккаунтом', async () => {
      const student = store.addStudent({ email: 'shared@mail.tj' });
      store.addForeignAccount('+992900000000', 'shared@mail.tj', AccountType.STUDENT);

      await post(
        `/api/v1/students/${student.id}/invite`,
        await actor('Permission.Students.Invite'),
      ).expect(409);
    });

    it('422 на заблокированного: сначала снимите блокировку', async () => {
      const student = store.addStudent({ status: StudentStatus.BLOCK });

      await post(
        `/api/v1/students/${student.id}/invite`,
        await actor('Permission.Students.Invite'),
      ).expect(422);
    });

    it('400 на негодную почту и на лишнее поле', async () => {
      const student = store.addStudent();
      const token = await actor('Permission.Students.Invite');

      await post(`/api/v1/students/${student.id}/invite`, token, { email: 'не-почта' }).expect(400);
      await post(`/api/v1/students/${student.id}/invite`, token, {
        password: 'подсунем-свой',
      }).expect(400);
    });

    it('404 на неизвестного студента', async () => {
      await post(
        `/api/v1/students/${randomUUID()}/invite`,
        await actor('Permission.Students.Invite'),
      ).expect(404);
    });
  });

  describe('OpenAPI', () => {
    it('оба маршрута в документе, invite — 201, block — 200', () => {
      const document = buildOpenApiDocument(app);

      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining(['/api/v1/students/{id}/block', '/api/v1/students/{id}/invite']),
      );

      // Приглашение создаёт аккаунт — 201; блокировка ничего не создаёт — 200,
      // а не дефолтный для POST 201 (ровно такое расхождение ловилось в 0001).
      expect(document.paths['/api/v1/students/{id}/invite']?.post?.responses['201']).toBeDefined();

      const block = document.paths['/api/v1/students/{id}/block']?.post;
      expect(block?.responses['200']).toBeDefined();
      expect(block?.responses['201']).toBeUndefined();
    });
  });
});
