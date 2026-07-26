import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus, AccountType, Locale } from '@prisma/client';
import type { Session } from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import type {
  AccountWithProfile,
  CreateSessionInput,
  CreateStudentAccountInput,
  RotateSessionInput,
} from 'src/auth/auth.repository';
import { AuthRepository } from 'src/auth/auth.repository';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { LoggerModule } from 'src/logger/logger.module';
import { PhoneModule } from 'src/phone/phone.module';

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

  findAccountByPhone(phone: string): Promise<AccountWithProfile | null> {
    const found = [...this.accounts.values()].find((a) => a.phone === phone);
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

  /** Для сценария с заблокированным аккаунтом. */
  block(phone: string): void {
    const account = [...this.accounts.values()].find((a) => a.phone === phone);
    if (account) account.status = AccountStatus.BLOCKED;
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

  const url = (path: string) => `/api/v1/auth/${path}`;

  beforeEach(async () => {
    repository = new InMemoryAuthRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, LoggerModule, PhoneModule, AuthModule],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
      ],
    })
      .overrideProvider(AuthRepository)
      .useValue(repository)
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
});
