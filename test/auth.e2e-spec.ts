import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus, AccountType, Locale } from '@prisma/client';
import type { PasswordResetCode, Session } from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import type {
  AccountWithProfile,
  CompletePasswordResetInput,
  CreatePasswordResetCodeInput,
  CreateSessionInput,
  CreateStudentAccountInput,
  RotateSessionInput,
} from 'src/auth/auth.repository';
import { AuthRepository } from 'src/auth/auth.repository';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { LoggerModule } from 'src/logger/logger.module';
import type { MailMessage } from 'src/mailer';
import { MailerService } from 'src/mailer';
import { MailerModule } from 'src/mailer/mailer.module';
import { PhoneModule } from 'src/phone/phone.module';
import { RateLimitModule } from 'src/rate-limit/rate-limit.module';
import { RedisModule } from 'src/redis/redis.module';
import { RedisService } from 'src/redis/redis.service';

import { InMemoryRedis } from './support/in-memory-redis';

/**
 * Полный HTTP-путь Auth: DTO-валидация → guard → сервис → интерцептор/фильтр.
 * Вместо PostgreSQL подставлено хранилище в памяти — так сценарий
 * «регистрация → вход → ротация → выход» проверяется на любой машине.
 * Сами Prisma-запросы проверяются отдельно, на реальной БД.
 */
class InMemoryAuthRepository {
  private readonly accounts = new Map<string, AccountWithProfile>();
  private readonly studentPhones = new Map<string, { id: string }>();
  private readonly sessions = new Map<string, Session>();
  private readonly resetCodes = new Map<string, PasswordResetCode>();

  findAccountByPhone(phone: string): Promise<AccountWithProfile | null> {
    const found = [...this.accounts.values()].find((a) => a.phone === phone);
    return Promise.resolve(found ?? null);
  }

  findAccountByEmail(email: string): Promise<AccountWithProfile | null> {
    const found = [...this.accounts.values()].find((a) => a.email === email);
    return Promise.resolve(found ?? null);
  }

  findAccountById(id: string): Promise<AccountWithProfile | null> {
    return Promise.resolve(this.accounts.get(id) ?? null);
  }

  findAccountByPhoneOrEmail(
    phone: string,
    email: string,
  ): Promise<{ phone: string; email: string } | null> {
    const found = [...this.accounts.values()].find((a) => a.phone === phone || a.email === email);
    return Promise.resolve(found ? { phone: found.phone, email: found.email } : null);
  }

  findStudentByPhone(phone: string): Promise<{ id: string } | null> {
    return Promise.resolve(this.studentPhones.get(phone) ?? null);
  }

  createStudentAccount(input: CreateStudentAccountInput): Promise<AccountWithProfile> {
    const account: AccountWithProfile = {
      id: randomUUID(),
      phone: input.phone,
      email: input.email,
      passwordHash: input.passwordHash,
      type: AccountType.STUDENT,
      status: AccountStatus.ACTIVE,
      locale: input.locale,
      student: { id: randomUUID(), firstName: input.firstName, lastName: input.lastName },
      employee: null,
    };

    this.accounts.set(account.id, account);
    this.studentPhones.set(input.phone, { id: account.student!.id });

    return Promise.resolve(account);
  }

  touchLastLogin(): Promise<void> {
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
    if (!session || session.revokedAt) return Promise.resolve(false);

    session.revokedAt = new Date();
    return Promise.resolve(true);
  }

  revokeAllSessions(accountId: string): Promise<number> {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.accountId === accountId && !session.revokedAt) {
        session.revokedAt = new Date();
        count += 1;
      }
    }
    return Promise.resolve(count);
  }

  // --- Сброс пароля ---

  countPasswordResetCodesSince(accountId: string, since: Date): Promise<number> {
    const count = [...this.resetCodes.values()].filter(
      (code) => code.accountId === accountId && code.createdAt >= since,
    ).length;

    return Promise.resolve(count);
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
      .filter((c) => c.accountId === accountId && !c.consumedAt && c.expiresAt > now)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return Promise.resolve(found[0] ?? null);
  }

  consumeActivePasswordResetCodes(accountId: string): Promise<number> {
    let count = 0;
    for (const code of this.resetCodes.values()) {
      if (code.accountId === accountId && !code.consumedAt) {
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

  /** Для сценария с заблокированным аккаунтом. */
  block(phone: string): void {
    const account = [...this.accounts.values()].find((a) => a.phone === phone);
    if (account) account.status = AccountStatus.BLOCKED;
  }
}

/** Перехватывает письма вместо провайдера — код читается так же, как пользователем. */
class RecordingMailer extends MailerService {
  readonly sent: MailMessage[] = [];

  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  /** Шестизначный код из последнего письма. */
  lastCode(): string {
    const last = this.sent.at(-1);
    const found = last ? /\b(\d{6})\b/.exec(last.text) : null;
    if (!found) throw new Error('В последнем письме нет шестизначного кода');

    return found[1];
  }
}

const VALID_REGISTRATION = {
  firstName: 'Фаррух',
  lastName: 'Раҳимов',
  birthDate: '2004-05-12',
  address: 'г. Душанбе, ул. Рудаки, 25',
  email: 'Farrukh@Example.TJ',
  phone: '901234567',
  parentPhone: '907654321',
  password: 'очень-секретный-пароль',
};

const CANONICAL_PHONE = '+992901234567';

describe('Auth (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let repository: InMemoryAuthRepository;
  let mailer: RecordingMailer;
  let redis: InMemoryRedis;

  const url = (path: string) => `/api/v1/auth/${path}`;

  beforeEach(async () => {
    repository = new InMemoryAuthRepository();
    mailer = new RecordingMailer();
    // Счётчики лимитов заводятся заново на каждый тест: этот набор проверяет
    // сценарии auth, а не лимиты (их проверяет `rate-limit.e2e-spec.ts`),
    // и одно правило не должно закрывать вход соседнему тесту.
    redis = new InMemoryRedis();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        PhoneModule,
        // Redis приносится ради лимитов и тут же подменяется счётчиком
        // в памяти: настоящий клиент набору не нужен, а без клиента вовсе
        // лимитер ничего не считал бы — и сценарии auth проверялись бы
        // в конфигурации, отличной от прода.
        RedisModule,
        RateLimitModule,
        AuthModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
      ],
    })
      .overrideProvider(AuthRepository)
      .useValue(repository)
      .overrideProvider(MailerService)
      .useValue(mailer)
      .overrideProvider(RedisService)
      .useValue(redis.asRedisService())
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  /** Регистрация «по умолчанию» — исходная точка большинства сценариев. */
  const register = (overrides: Partial<typeof VALID_REGISTRATION> = {}) =>
    request(app.getHttpServer())
      .post(url('register'))
      .send({ ...VALID_REGISTRATION, ...overrides });

  describe('POST /auth/register', () => {
    it('создаёт аккаунт, нормализует телефон и email и возвращает { data }', async () => {
      const response = await register().expect(201);

      expect(response.body.data.account).toMatchObject({
        phone: CANONICAL_PHONE,
        email: 'farrukh@example.tj',
        type: AccountType.STUDENT,
        status: AccountStatus.ACTIVE,
        locale: Locale.RU,
        profile: { firstName: 'Фаррух', lastName: 'Раҳимов' },
      });
      expect(response.body.data.tokens).toMatchObject({
        tokenType: 'Bearer',
        expiresIn: 3600,
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
      });
    });

    it('не отдаёт хеш пароля и сам пароль', async () => {
      const response = await register().expect(201);

      const body = JSON.stringify(response.body);
      expect(body).not.toContain(VALID_REGISTRATION.password);
      expect(body).not.toContain('passwordHash');
      expect(body).not.toContain('argon2');
    });

    it('отвечает 400 на пароль короче 8 символов (ТЗ 3.1)', async () => {
      const response = await register({ password: 'корот' }).expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('отвечает 400 на номер, который не является телефоном', async () => {
      const response = await register({ phone: '12345' }).expect(400);

      expect(response.body.error.details).toMatchObject({ phone: expect.any(String) });
    });

    it('отвечает 400 на лишнее поле в теле запроса', async () => {
      const response = await request(app.getHttpServer())
        .post(url('register'))
        .send({ ...VALID_REGISTRATION, isAdmin: true })
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('отвечает 409, если телефон уже занят — в том числе записанный иначе', async () => {
      await register().expect(201);

      const response = await register({
        phone: '+992 (90) 123-45-67',
        email: 'other@example.tj',
      }).expect(409);

      expect(response.body.error.code).toBe('CONFLICT');
    });
  });

  describe('POST /auth/login', () => {
    it('пускает по номеру в любой записи и выдаёт токены', async () => {
      await register().expect(201);

      const response = await request(app.getHttpServer())
        .post(url('login'))
        .send({ phone: '90 123 45 67', password: VALID_REGISTRATION.password })
        .expect(200);

      expect(response.body.data.account.phone).toBe(CANONICAL_PHONE);
      expect(response.body.data.tokens.accessToken).toEqual(expect.any(String));
    });

    it('отвечает 401 и на неверный пароль, и на незарегистрированный номер — одинаково', async () => {
      await register().expect(201);

      const wrongPassword = await request(app.getHttpServer())
        .post(url('login'))
        .send({ phone: CANONICAL_PHONE, password: 'неверный-пароль' })
        .expect(401);

      const unknownPhone = await request(app.getHttpServer())
        .post(url('login'))
        .send({ phone: '+992915555555', password: 'неверный-пароль' })
        .expect(401);

      expect(wrongPassword.body.error.code).toBe('UNAUTHORIZED');
      expect(unknownPhone.body.error.message).toBe(wrongPassword.body.error.message);
    });

    it('отвечает 403 заблокированному аккаунту (ТЗ 5.3)', async () => {
      await register().expect(201);
      repository.block(CANONICAL_PHONE);

      const response = await request(app.getHttpServer())
        .post(url('login'))
        .send({ phone: CANONICAL_PHONE, password: VALID_REGISTRATION.password })
        .expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('POST /auth/refresh', () => {
    it('выдаёт новую пару, а предъявленный токен перестаёт работать (ротация, ТЗ 3.1)', async () => {
      const registered = await register().expect(201);
      const first = registered.body.data.tokens.refreshToken;

      const rotated = await request(app.getHttpServer())
        .post(url('refresh'))
        .send({ refreshToken: first })
        .expect(200);

      const second = rotated.body.data.tokens.refreshToken;
      expect(second).not.toBe(first);

      // Старый токен предъявлен повторно — сессия гасится целиком.
      await request(app.getHttpServer())
        .post(url('refresh'))
        .send({ refreshToken: first })
        .expect(401);

      // И новый токен той же сессии тоже больше не действует.
      await request(app.getHttpServer())
        .post(url('refresh'))
        .send({ refreshToken: second })
        .expect(401);
    });

    it('отвечает 401 на подделанный токен', async () => {
      const response = await request(app.getHttpServer())
        .post(url('refresh'))
        .send({ refreshToken: 'a'.repeat(40) })
        .expect(401);

      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('Выход', () => {
    it('требует access-токен: без заголовка — 401', async () => {
      await register().expect(201);

      await request(app.getHttpServer()).post(url('logout')).expect(401);
      await request(app.getHttpServer())
        .post(url('logout-all'))
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
    });

    it('гасит текущую сессию: её refresh-токен больше не обменивается', async () => {
      const registered = await register().expect(201);
      const { accessToken, refreshToken } = registered.body.data.tokens;

      const response = await request(app.getHttpServer())
        .post(url('logout'))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.data).toEqual({ revokedSessions: 1 });

      await request(app.getHttpServer()).post(url('refresh')).send({ refreshToken }).expect(401);
    });

    it('logout-all гасит все устройства сразу', async () => {
      await register().expect(201);

      const login = async () =>
        request(app.getHttpServer())
          .post(url('login'))
          .send({ phone: CANONICAL_PHONE, password: VALID_REGISTRATION.password })
          .expect(200);

      const first = await login();
      const second = await login();

      const response = await request(app.getHttpServer())
        .post(url('logout-all'))
        .set('Authorization', `Bearer ${first.body.data.tokens.accessToken}`)
        .expect(200);

      // Сессия регистрации плюс два входа.
      expect(response.body.data.revokedSessions).toBe(3);

      await request(app.getHttpServer())
        .post(url('refresh'))
        .send({ refreshToken: second.body.data.tokens.refreshToken })
        .expect(401);
    });
  });

  describe('Сброс пароля по email (ТЗ 3.1, 5.1)', () => {
    const CANONICAL_EMAIL = 'farrukh@example.tj';
    const NEW_PASSWORD = 'совсем-другой-пароль';

    const forgot = (email = CANONICAL_EMAIL) =>
      request(app.getHttpServer()).post(url('password/forgot')).send({ email });

    const reset = (body: { email?: string; code: string; newPassword?: string }) =>
      request(app.getHttpServer())
        .post(url('password/reset'))
        .send({ email: CANONICAL_EMAIL, newPassword: NEW_PASSWORD, ...body });

    const login = (password: string) =>
      request(app.getHttpServer()).post(url('login')).send({ phone: CANONICAL_PHONE, password });

    it('отправляет письмо с шестизначным кодом на языке аккаунта', async () => {
      await register().expect(201);

      await forgot().expect(200);

      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0].to).toBe(CANONICAL_EMAIL);
      expect(mailer.sent[0].subject).toBe('Восстановление пароля — CRM Omuz');
      expect(mailer.lastCode()).toMatch(/^\d{6}$/);
    });

    it('отвечает одинаково на известный и неизвестный email, но письмо шлёт только на известный', async () => {
      await register().expect(201);

      const known = await forgot().expect(200);
      const unknown = await forgot('нет-такого@example.tj').expect(200);

      expect(unknown.body.data.message).toBe(known.body.data.message);
      expect(mailer.sent).toHaveLength(1);
    });

    it('меняет пароль по коду: старый больше не пускает, новый пускает', async () => {
      await register().expect(201);
      await forgot().expect(200);

      const response = await reset({ code: mailer.lastCode() }).expect(200);
      expect(response.body.data.revokedSessions).toBeGreaterThanOrEqual(1);

      await login(VALID_REGISTRATION.password).expect(401);
      await login(NEW_PASSWORD).expect(200);
    });

    it('гасит все сессии: выданный до сброса refresh-токен больше не обменивается', async () => {
      const registered = await register().expect(201);
      const { refreshToken } = registered.body.data.tokens;

      await forgot().expect(200);
      await reset({ code: mailer.lastCode() }).expect(200);

      await request(app.getHttpServer()).post(url('refresh')).send({ refreshToken }).expect(401);
    });

    it('отвечает 422 на неверный код', async () => {
      await register().expect(201);
      await forgot().expect(200);

      const wrong = mailer.lastCode() === '000000' ? '000001' : '000000';
      const response = await reset({ code: wrong }).expect(422);

      expect(response.body.error.code).toBe('UNPROCESSABLE_ENTITY');
    });

    it('код одноразовый: второй раз тем же кодом — 422', async () => {
      await register().expect(201);
      await forgot().expect(200);
      const code = mailer.lastCode();

      await reset({ code }).expect(200);
      await reset({ code, newPassword: 'ещё-один-пароль' }).expect(422);
    });

    it('новый запрос кода отменяет предыдущий', async () => {
      await register().expect(201);

      await forgot().expect(200);
      const first = mailer.lastCode();

      await forgot().expect(200);
      const second = mailer.lastCode();
      expect(second).not.toBe(first);

      await reset({ code: first }).expect(422);
      await reset({ code: second }).expect(200);
    });

    it('после трёх неверных попыток код гасится — верный уже не срабатывает (ТЗ 3.1)', async () => {
      await register().expect(201);
      await forgot().expect(200);
      const code = mailer.lastCode();

      const wrong = (n: number) => String(n).padStart(6, '0');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const candidate = wrong(attempt) === code ? wrong(attempt + 100) : wrong(attempt);
        await reset({ code: candidate }).expect(422);
      }

      await reset({ code }).expect(422);
    });

    it('перестаёт слать письма после трёх запросов в час (ТЗ 3.1)', async () => {
      await register().expect(201);

      for (let i = 0; i < 4; i += 1) {
        await forgot().expect(200);
      }

      // Четвёртый запрос принят так же, как остальные, но письмо не ушло.
      expect(mailer.sent).toHaveLength(3);
    });

    it('не шлёт код заблокированному аккаунту', async () => {
      await register().expect(201);
      repository.block(CANONICAL_PHONE);

      await forgot().expect(200);

      expect(mailer.sent).toHaveLength(0);
    });

    it('проверяет формат кода и длину нового пароля', async () => {
      await register().expect(201);
      await forgot().expect(200);

      await reset({ code: '12345' }).expect(400);
      await reset({ code: 'абвгде' }).expect(400);
      await reset({ code: mailer.lastCode(), newPassword: 'корот' }).expect(400);
    });

    it('отвечает 400 на некорректный email', async () => {
      const response = await forgot('не-адрес').expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
