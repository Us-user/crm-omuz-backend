import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus, AccountType, Locale } from '@prisma/client';
import type { PasswordResetCode, Session } from '@prisma/client';
import request from 'supertest';

import type { AccountWithProfile, CreateSessionInput } from 'src/auth/auth.repository';
import { AuthRepository } from 'src/auth/auth.repository';
import { AuthModule } from 'src/auth/auth.module';
import { PasswordService } from 'src/auth/password.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerService } from 'src/mailer';
import { MailerModule } from 'src/mailer/mailer.module';
import { PhoneModule } from 'src/phone/phone.module';
import {
  LOGIN_RATE_LIMIT,
  PASSWORD_FORGOT_RATE_LIMIT,
  PASSWORD_RESET_RATE_LIMIT,
} from 'src/rate-limit';
import { RateLimitModule } from 'src/rate-limit/rate-limit.module';
import { RedisModule } from 'src/redis/redis.module';
import { RedisService } from 'src/redis/redis.service';
import { buildOpenApiDocument } from 'src/swagger';

import { InMemoryRedis } from './support/in-memory-redis';

const PHONE = '+992901234567';
const PASSWORD = 'очень-секретный-пароль';

/**
 * Репозиторий ровно под этот набор: он проверяет лимиты, а не сценарии auth
 * (те живут в `auth.e2e-spec.ts` на полноценном хранилище в памяти). Здесь
 * нужен один заведённый аккаунт, чтобы отличить успешный вход от неуспешного.
 */
class MinimalAuthRepository {
  private account: AccountWithProfile | null = null;

  async seedAccount(passwords: PasswordService): Promise<void> {
    this.account = {
      id: randomUUID(),
      phone: PHONE,
      email: 'farrukh@example.tj',
      passwordHash: await passwords.hash(PASSWORD),
      type: AccountType.STUDENT,
      status: AccountStatus.ACTIVE,
      locale: Locale.RU,
      student: { id: randomUUID(), firstName: 'Фаррух', lastName: 'Раҳимов' },
      employee: null,
    };
  }

  findAccountByPhone(phone: string): Promise<AccountWithProfile | null> {
    return Promise.resolve(this.account?.phone === phone ? this.account : null);
  }

  findAccountByEmail(): Promise<AccountWithProfile | null> {
    // Неизвестный адрес: `forgot` отвечает тем же текстом, что и известному,
    // а лимит при этом считается — в том и смысл второго рубежа.
    return Promise.resolve(null);
  }

  touchLastLogin(): Promise<void> {
    return Promise.resolve();
  }

  createSession(input: CreateSessionInput): Promise<Session> {
    return Promise.resolve({ id: input.id } as Session);
  }

  countPasswordResetCodesSince(): Promise<number> {
    return Promise.resolve(0);
  }

  findActivePasswordResetCode(): Promise<PasswordResetCode | null> {
    return Promise.resolve(null);
  }
}

describe('Ограничение частоты запросов (e2e, Redis в памяти)', () => {
  let app: INestApplication;
  let redis: InMemoryRedis;
  let repository: MinimalAuthRepository;

  const url = (path: string) => `/api/v1/auth/${path}`;
  const post = (path: string, body: object) =>
    request(app.getHttpServer()).post(url(path)).send(body);

  beforeEach(async () => {
    redis = new InMemoryRedis();
    repository = new MinimalAuthRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        PhoneModule,
        // Клиент Redis подменяется счётчиком в памяти, но сам `RateLimitService`
        // остаётся настоящим: ключи, разбор ответа и fail-open проверяются те же,
        // что поедут в прод. Не проверенным остаётся только выполнение
        // Lua-скрипта настоящим Redis.
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
      .useValue({ send: (): Promise<void> => Promise.resolve() })
      .overrideProvider(RedisService)
      .useValue(redis.asRedisService())
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();

    await repository.seedAccount(app.get(PasswordService));
  });

  afterEach(async () => {
    await app?.close();
  });

  /** Повторяет запрос n раз подряд и отдаёт коды ответов по порядку. */
  const repeat = async (path: string, body: object, times: number): Promise<number[]> => {
    const codes: number[] = [];
    for (let i = 0; i < times; i += 1) {
      codes.push((await post(path, body)).status);
    }

    return codes;
  };

  // ───────────────────────── Лимит по адресу ─────────────────────────

  describe('лимит по адресу клиента', () => {
    it('пропускает ровно столько запросов, сколько разрешено, и отбивает следующий', async () => {
      const limit = PASSWORD_FORGOT_RATE_LIMIT.ip.limit;

      const codes = await repeat('password/forgot', { email: 'a@example.tj' }, limit);
      expect(codes).toEqual(Array<number>(limit).fill(200));

      await post('password/forgot', { email: 'a@example.tj' }).expect(429);
    });

    it('считает адрес, а не адресата: разные почты расходуют один счётчик', async () => {
      // Иначе перебор «кто зарегистрирован» шёл бы по тысяче адресов подряд
      // мимо всякого лимита.
      for (let i = 0; i < PASSWORD_FORGOT_RATE_LIMIT.ip.limit; i += 1) {
        await post('password/forgot', { email: `person-${String(i)}@example.tj` }).expect(200);
      }

      await post('password/forgot', { email: 'ещё-один@example.tj' }).expect(429);
    });

    it('отбитый запрос отвечает в общем формате ошибок проекта', async () => {
      await repeat(
        'password/forgot',
        { email: 'a@example.tj' },
        PASSWORD_FORGOT_RATE_LIMIT.ip.limit,
      );

      const response = await post('password/forgot', { email: 'a@example.tj' }).expect(429);

      expect(response.body).toEqual({
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: expect.stringContaining('Слишком много запросов') as string,
          details: { retryAfterSeconds: expect.any(Number) as number },
          requestId: expect.any(String) as string,
          timestamp: expect.any(String) as string,
        },
      });
    });

    it('называет, когда повторить, — и в теле, и заголовком Retry-After', async () => {
      await repeat(
        'password/forgot',
        { email: 'a@example.tj' },
        PASSWORD_FORGOT_RATE_LIMIT.ip.limit,
      );

      const response = await post('password/forgot', { email: 'a@example.tj' }).expect(429);
      const header = Number(response.headers['retry-after']);

      expect(header).toBeGreaterThan(0);
      expect(header).toBeLessThanOrEqual(PASSWORD_FORGOT_RATE_LIMIT.ip.windowSeconds);
      expect(response.body.error.details).toEqual({ retryAfterSeconds: header });
    });

    it('счётчики эндпоинтов не смешиваются', async () => {
      // Исчерпанный запрос кода не должен закрывать ввод кода: это разные
      // действия, и общий счётчик отнимал бы у человека вторую половину
      // сценария, до которой он уже дошёл.
      await repeat(
        'password/forgot',
        { email: 'a@example.tj' },
        PASSWORD_FORGOT_RATE_LIMIT.ip.limit,
      );
      await post('password/forgot', { email: 'a@example.tj' }).expect(429);

      await post('password/reset', {
        email: 'a@example.tj',
        code: '123456',
        newPassword: 'новый-пароль-123',
      }).expect(422);
    });
  });

  // ───────────────────────── Лимит по логину ─────────────────────────

  describe('лимит по логину', () => {
    it('срабатывает раньше лимита по адресу — он строже', async () => {
      const limit = LOGIN_RATE_LIMIT.subject?.limit ?? 0;
      expect(limit).toBeLessThan(LOGIN_RATE_LIMIT.ip.limit);

      // Форма заведомо неполная: 400 приходит от ValidationPipe, но лимит
      // расходуется — guard стоит **до** валидации, и это осознанно.
      const codes = await repeat('login', { phone: PHONE }, limit);
      expect(codes).toEqual(Array<number>(limit).fill(400));

      await post('login', { phone: PHONE }).expect(429);
    });

    it('неверно заполненная форма расходует лимит наравне с верной', async () => {
      // Иначе перебор шёл бы заведомо ломаным запросом мимо всякого счёта.
      await repeat('login', { phone: PHONE }, LOGIN_RATE_LIMIT.subject?.limit ?? 0);

      await post('login', { phone: PHONE, password: PASSWORD }).expect(429);
    });

    it('номер приводится к E.164 — лимит не обходится сменой формы записи', async () => {
      const limit = LOGIN_RATE_LIMIT.subject?.limit ?? 0;
      const forms = ['901234567', '992901234567', '+992 90 123-45-67', PHONE];

      for (let i = 0; i < limit; i += 1) {
        await post('login', { phone: forms[i % forms.length] }).expect(400);
      }

      await post('login', { phone: '90 123 45 67' }).expect(429);
    });

    it('чужой номер своего счётчика не расходует', async () => {
      await repeat('login', { phone: PHONE }, LOGIN_RATE_LIMIT.subject?.limit ?? 0);
      await post('login', { phone: PHONE }).expect(429);

      // Лимит по адресу (20) ещё не исчерпан, поэтому соседний номер проходит.
      await post('login', { phone: '+992907654321' }).expect(400);
    });

    it('успешный вход обнуляет счётчик номера', async () => {
      // Иначе лимит работал бы против того, кого защищает: человек,
      // вспомнивший пароль после пары опечаток, доживал бы окно
      // с почти исчерпанным лимитом.
      const subjectKeys = `rl:${LOGIN_RATE_LIMIT.action}:subject:`;

      await post('login', { phone: PHONE, password: 'не-тот-пароль' }).expect(401);
      await post('login', { phone: PHONE, password: 'снова-не-тот' }).expect(401);
      expect(redis.hitsMatching(subjectKeys)).toBe(2);

      await post('login', { phone: PHONE, password: PASSWORD }).expect(200);

      expect(redis.hitsMatching(subjectKeys)).toBe(0);
    });

    it('но счётчик по адресу успешный вход не трогает', async () => {
      // Успех одного человека не должен списывать перебор, который идёт
      // с той же машины по другим номерам.
      await post('login', { phone: PHONE, password: PASSWORD }).expect(200);

      expect(redis.hitsMatching(`rl:${LOGIN_RATE_LIMIT.action}:ip:`)).toBe(1);
    });
  });

  // ───────────────────── Недоступный Redis ─────────────────────

  describe('недоступный Redis', () => {
    it('пропускает запросы, а не закрывает вход всему центру', async () => {
      // Решение пользователя (0040), fail-open. Цена названа прямо:
      // в это время перебор ничем не ограничен.
      redis.failWith = new Error('connect ECONNREFUSED 127.0.0.1:6379');

      const codes = await repeat(
        'password/forgot',
        { email: 'a@example.tj' },
        PASSWORD_FORGOT_RATE_LIMIT.ip.limit * 2,
      );

      expect(codes.every((code) => code === 200)).toBe(true);
    });

    it('успешный вход при этом всё равно проходит', async () => {
      redis.failWith = new Error('нет соединения');

      await post('login', { phone: PHONE, password: PASSWORD }).expect(200);
    });
  });

  // ───────────────────────── Не задето лимитом ─────────────────────────

  it('обычный вход и запрос кода работают как прежде', async () => {
    await post('login', { phone: PHONE, password: PASSWORD }).expect(200);
    await post('password/forgot', { email: 'a@example.tj' }).expect(200);
  });

  it('429 на запросе кода существования аккаунта не выдаёт', async () => {
    // Эндпоинт молчит о том, зарегистрирован ли адрес (0003), и лимит это
    // свойство не ломает: он срабатывает на любой почте, известной и нет.
    await repeat(
      'password/forgot',
      { email: 'неизвестный@example.tj' },
      PASSWORD_FORGOT_RATE_LIMIT.ip.limit,
    );

    await post('password/forgot', { email: 'неизвестный@example.tj' }).expect(429);
  });

  // ───────────────────────────── OpenAPI ─────────────────────────────

  describe('OpenAPI', () => {
    it('429 описан у всех пяти эндпоинтов auth', () => {
      const paths = buildOpenApiDocument(app).paths;

      for (const path of [
        '/api/v1/auth/register',
        '/api/v1/auth/login',
        '/api/v1/auth/refresh',
        '/api/v1/auth/password/forgot',
        '/api/v1/auth/password/reset',
      ]) {
        expect(paths[path]?.post?.responses['429']).toBeDefined();
      }
    });

    it('у эндпоинтов без лимита его в документе нет', () => {
      const paths = buildOpenApiDocument(app).paths;

      expect(paths['/api/v1/auth/logout']?.post?.responses['429']).toBeUndefined();
    });
  });

  // ───────────────────── Лимит ввода кода ─────────────────────

  it('ввод кода ограничен своим лимитом', async () => {
    // Перебор одного кода уже упирается в три попытки из таблицы (0003),
    // но цикл «запросил новый код — снова три попытки» тем лимитом не покрыт.
    const body = { email: 'a@example.tj', code: '123456', newPassword: 'новый-пароль-123' };

    const codes = await repeat('password/reset', body, PASSWORD_RESET_RATE_LIMIT.ip.limit);
    expect(codes).toEqual(Array<number>(PASSWORD_RESET_RATE_LIMIT.ip.limit).fill(422));

    await post('password/reset', body).expect(429);
  });
});
