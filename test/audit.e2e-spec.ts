import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountType, DirectoryStatus } from '@prisma/client';
import request from 'supertest';

import { AuditOutcome } from 'src/audit';
import { AuditModule } from 'src/audit/audit.module';
import type {
  AuditActor,
  AuditLogListParams,
  AuditLogRow,
  AuditLogWriteInput,
} from 'src/audit/audit.repository';
import { AuditRepository } from 'src/audit/audit.repository';
import type { AuditLogDto } from 'src/audit/dto';
import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, SortOrder, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import type {
  CouponListParams,
  CouponRow,
  CouponUpdateInput,
  CouponWriteInput,
} from 'src/coupons/coupons.repository';
import { CouponsRepository } from 'src/coupons/coupons.repository';
import { CouponsModule } from 'src/coupons/coupons.module';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { PhoneModule } from 'src/phone/phone.module';
import { RbacModule } from 'src/rbac/rbac.module';
import { RbacRepository } from 'src/rbac/rbac.repository';
import { buildOpenApiDocument } from 'src/swagger';

/** `{ data }` ответа с ожидаемым типом — тела supertest типизированы как `any`. */
const dataOf = <T>(response: { body: unknown }): T => (response.body as { data: T }).data;

/**
 * Запись журнала идёт **мимо ответа**: перехватчик её не ждёт. Поэтому перед
 * проверкой нужно отдать управление циклу событий — ровно один такт, потому что
 * хранилище в памяти отвечает сразу. Это же и показывает свойство, ради которого
 * запись сделана асинхронной: клиент получает ответ раньше, чем строка легла.
 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Права аккаунта в памяти вместо трёх таблиц RBAC (как в остальных наборах). */
class InMemoryRbacRepository {
  private readonly codesByAccount = new Map<string, string[]>();

  grant(accountId: string, codes: string[]): void {
    this.codesByAccount.set(accountId, codes);
  }

  reset(): void {
    this.codesByAccount.clear();
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

/**
 * Журнал в памяти. Отбор **повторяет правила репозитория** (фильтры, период
 * полуинтервалом, поиск по четырём полям, порядок по времени), а не подставляет
 * готовые строки: иначе главное свойство сессии — «сделал действие → оно видно
 * в журнале» — проверялось бы заготовленным ответом, а не работой кода.
 */
class InMemoryAuditRepository {
  readonly rows: AuditLogRow[] = [];
  readonly actors = new Map<string, AuditActor>();
  /** Одноразовый сбой записи — им проверяется, что действие от него не страдает. */
  failNextWrite = false;

  reset(): void {
    this.rows.length = 0;
    this.actors.clear();
    this.failNextWrite = false;
  }

  create(input: AuditLogWriteInput): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;

      return Promise.reject(new Error('журнал недоступен'));
    }

    this.rows.push({ id: randomUUID(), createdAt: new Date(), ...input });

    return Promise.resolve();
  }

  findActor(accountId: string): Promise<AuditActor | null> {
    return Promise.resolve(this.actors.get(accountId) ?? null);
  }

  findMany(params: AuditLogListParams): Promise<{ rows: AuditLogRow[]; total: number }> {
    let rows = [...this.rows];

    if (params.accountId !== undefined) {
      rows = rows.filter((row) => row.accountId === params.accountId);
    }
    if (params.actorType !== undefined) {
      rows = rows.filter((row) => row.actorType === params.actorType);
    }
    if (params.action !== undefined) rows = rows.filter((row) => row.action === params.action);
    if (params.entityId !== undefined) {
      rows = rows.filter((row) => row.entityId === params.entityId);
    }
    if (params.succeeded !== undefined) {
      rows = rows.filter((row) => row.statusCode < 400 === params.succeeded);
    }
    if (params.from !== undefined) {
      rows = rows.filter((row) => row.createdAt.getTime() >= (params.from as Date).getTime());
    }
    if (params.to !== undefined) {
      rows = rows.filter((row) => row.createdAt.getTime() < (params.to as Date).getTime());
    }
    if (params.search !== undefined) {
      const needle = params.search.toLowerCase();
      rows = rows.filter((row) =>
        [row.actorName, row.actorPhone, row.action, row.path].some(
          (field) => field !== null && field.toLowerCase().includes(needle),
        ),
      );
    }

    rows.sort((a, b) =>
      params.order === SortOrder.Asc
        ? a.createdAt.getTime() - b.createdAt.getTime()
        : b.createdAt.getTime() - a.createdAt.getTime(),
    );

    return Promise.resolve({
      rows: rows.slice(params.skip, params.skip + params.take),
      total: rows.length,
    });
  }
}

/** Купоны в памяти — обычный CRUD, на котором проверяется работа перехватчика. */
class InMemoryCouponsRepository {
  readonly coupons = new Map<string, CouponRow>();

  reset(): void {
    this.coupons.clear();
  }

  findMany(params: CouponListParams): Promise<{ rows: CouponRow[]; total: number }> {
    const rows = [...this.coupons.values()];

    return Promise.resolve({
      rows: rows.slice(params.skip, params.skip + params.take),
      total: rows.length,
    });
  }

  findById(id: string): Promise<CouponRow | null> {
    return Promise.resolve(this.coupons.get(id) ?? null);
  }

  findByName(name: string): Promise<{ id: string; name: string } | null> {
    const twin = [...this.coupons.values()].find(
      (row) => row.name.toLowerCase() === name.toLowerCase(),
    );

    return Promise.resolve(twin ? { id: twin.id, name: twin.name } : null);
  }

  findCourses(): Promise<[]> {
    return Promise.resolve([]);
  }

  create(input: CouponWriteInput): Promise<CouponRow> {
    const row = {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      amount: input.amount,
      validFrom: input.validFrom,
      validTo: input.validTo,
      status: input.status ?? DirectoryStatus.ACTIVE,
      createdAt: new Date(),
      courses: [],
      _count: { leads: 0 },
    } as unknown as CouponRow;

    this.coupons.set(row.id, row);

    return Promise.resolve(row);
  }

  update(id: string, input: CouponUpdateInput): Promise<CouponRow> {
    // `undefined` Prisma пропускает — хранилище повторяет это правило,
    // иначе не переданное поле затирало бы прежнее значение.
    const patch = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
    const row = { ...(this.coupons.get(id) as CouponRow), ...patch };
    this.coupons.set(id, row);

    return Promise.resolve(row);
  }

  delete(id: string): Promise<void> {
    this.coupons.delete(id);

    return Promise.resolve();
  }
}

const VIEW_LOGS = 'Permission.Administration.ViewLogs';
const COUPON_CODES = [
  'Permission.Coupons.Views',
  'Permission.Coupons.Create',
  'Permission.Coupons.Update',
  'Permission.Coupons.Delete',
];

describe('Журнал действий (ТЗ 3.6, 5.15)', () => {
  let app: INestApplication;
  let tokens: TokenService;
  const rbac = new InMemoryRbacRepository();
  const audit = new InMemoryAuditRepository();
  const coupons = new InMemoryCouponsRepository();

  beforeEach(async () => {
    rbac.reset();
    audit.reset();
    coupons.reset();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        PhoneModule,
        // Порядок тот же, что в `AppModule`, и он значим: глобальные guard'ы
        // выполняются в порядке регистрации, а журнал обязан подписаться
        // на ответ раньше, чем `JwtAuthGuard` откажет запросу без токена.
        AuditModule,
        AuthModule,
        RbacModule,
        CouponsModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
      ],
    })
      .overrideProvider(AuthRepository)
      .useValue({})
      .overrideProvider(RbacRepository)
      .useValue(rbac)
      .overrideProvider(AuditRepository)
      .useValue(audit)
      .overrideProvider(CouponsRepository)
      .useValue(coupons)
      .compile();

    tokens = moduleRef.get(TokenService, { strict: false });

    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  const actor = async (
    codes: string[] = [...COUPON_CODES, VIEW_LOGS],
    profile: Partial<AuditActor> = {},
  ): Promise<{ token: string; accountId: string }> => {
    const accountId = randomUUID();
    rbac.grant(accountId, codes);
    audit.actors.set(accountId, {
      phone: '+992901234567',
      type: AccountType.EMPLOYEE,
      firstName: 'Фаррух',
      lastName: 'Раҳимов',
      ...profile,
    });

    const { accessToken } = await tokens.issuePair({
      sub: accountId,
      sid: randomUUID(),
      type: AccountType.EMPLOYEE,
    });

    return { token: accessToken, accountId };
  };

  const studentToken = async (): Promise<string> =>
    (
      await tokens.issuePair({
        sub: randomUUID(),
        sid: randomUUID(),
        type: AccountType.STUDENT,
      })
    ).accessToken;

  const createCoupon = async (token: string, name = 'Осень 2026'): Promise<{ id: string }> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/coupons')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, amount: 150 })
      .expect(201);

    return dataOf<{ id: string }>(response);
  };

  const logs = async (token: string, query = ''): Promise<AuditLogDto[]> => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/admin/logs${query}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    return dataOf<AuditLogDto[]>(response);
  };

  // --- Что попадает в журнал -------------------------------------------

  describe('перехватчик', () => {
    it('изменяющий запрос попадает в журнал: кто, что, над чем и когда', async () => {
      const { token, accountId } = await actor();

      const coupon = await createCoupon(token);
      await settle();

      const rows = await logs(token);
      const entry = rows.find((row) => row.action === 'Coupons.Create');

      expect(entry).toMatchObject({
        action: 'Coupons.Create',
        method: 'POST',
        path: '/api/v1/coupons',
        entityId: coupon.id,
        statusCode: 201,
        outcome: AuditOutcome.Success,
        // Сквозная трассировка: та же метка, что в логах приложения.
        requestId: expect.any(String),
      });
      // «Кто» — ссылка на аккаунт и снимок имени рядом с ней.
      expect(entry?.actor).toEqual({
        accountId,
        name: 'Фаррух Раҳимов',
        phone: '+992901234567',
        type: AccountType.EMPLOYEE,
      });
      expect(typeof entry?.createdAt).toBe('string');
    });

    it('чтение в журнал не пишется', async () => {
      const { token } = await actor();

      await request(app.getHttpServer())
        .get('/api/v1/coupons')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await settle();

      expect(audit.rows).toHaveLength(0);
    });

    it('правка и удаление берут идентификатор из пути', async () => {
      const { token } = await actor();
      const coupon = await createCoupon(token);

      await request(app.getHttpServer())
        .put(`/api/v1/coupons/${coupon.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 200 })
        .expect(200);

      await request(app.getHttpServer())
        .delete(`/api/v1/coupons/${coupon.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await settle();

      expect(audit.rows.map((row) => [row.action, row.method, row.path, row.entityId])).toEqual([
        ['Coupons.Create', 'POST', '/api/v1/coupons', coupon.id],
        ['Coupons.Update', 'PUT', '/api/v1/coupons/:id', coupon.id],
        ['Coupons.Delete', 'DELETE', '/api/v1/coupons/:id', coupon.id],
      ]);
    });

    it('отказ в правах записан отдельной строкой, и действие не состоялось', async () => {
      const { token } = await actor([VIEW_LOGS]);

      await request(app.getHttpServer())
        .post('/api/v1/coupons')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Осень 2026', amount: 150 })
        .expect(403);
      await settle();

      const rows = await logs(token);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'Coupons.Create', statusCode: 403, entityId: null });
      expect(coupons.coupons.size).toBe(0);
    });

    it('запрос без токена тоже виден: кто-то ломился в закрытый эндпоинт', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/coupons')
        .send({ name: 'Осень 2026', amount: 150 })
        .expect(401);
      await settle();

      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        action: 'Coupons.Create',
        statusCode: 401,
        accountId: null,
        actorName: null,
      });
    });

    it('ошибка формы действием не является и в журнал не идёт', async () => {
      const { token } = await actor();

      await request(app.getHttpServer())
        .post('/api/v1/coupons')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '', amount: 'много' })
        .expect(400);
      await settle();

      expect(audit.rows).toHaveLength(0);
    });

    it('сбой записи журнала не отменяет действие', async () => {
      const { token } = await actor();
      audit.failNextWrite = true;

      await request(app.getHttpServer())
        .post('/api/v1/coupons')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Осень 2026', amount: 150 })
        .expect(201);
      await settle();

      expect(coupons.coupons.size).toBe(1);
      expect(audit.rows).toHaveLength(0);
    });

    it('удалённый аккаунт: строка остаётся без ссылки и без имени', async () => {
      const { token, accountId } = await actor();
      audit.actors.delete(accountId);

      await createCoupon(token);
      await settle();

      expect(audit.rows[0]).toMatchObject({ accountId: null, actorName: null, actorPhone: null });
      expect(audit.rows[0]?.action).toBe('Coupons.Create');
    });
  });

  // --- Экран Administration → Logs -------------------------------------

  describe('GET /admin/logs', () => {
    const seed = async (token: string): Promise<void> => {
      await createCoupon(token, 'Осень 2026');
      await createCoupon(token, 'Зима 2027');
      await settle();
    };

    it('свежие сверху и постранично', async () => {
      const { token } = await actor();
      await seed(token);

      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/logs?limit=1')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(dataOf<AuditLogDto[]>(response)).toHaveLength(1);
      expect((response.body as { meta: { total: number } }).meta.total).toBe(2);
    });

    it('исход выводится из кода ответа', async () => {
      const { token } = await actor();
      await seed(token);

      await request(app.getHttpServer())
        .delete(`/api/v1/coupons/${randomUUID()}`)
        .send()
        .expect(401);
      await settle();

      const success = await logs(token, `?outcome=${AuditOutcome.Success}`);
      const denied = await logs(token, `?outcome=${AuditOutcome.Denied}`);

      expect(success).toHaveLength(2);
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatchObject({ statusCode: 401, outcome: AuditOutcome.Denied });
    });

    it('фильтры по действию, аккаунту и поиск по имени', async () => {
      const { token, accountId } = await actor();
      await seed(token);

      expect(await logs(token, '?action=Coupons.Create')).toHaveLength(2);
      expect(await logs(token, '?action=Students.Create')).toHaveLength(0);
      expect(await logs(token, `?accountId=${accountId}`)).toHaveLength(2);
      expect(await logs(token, `?accountId=${randomUUID()}`)).toHaveLength(0);
      expect(await logs(token, '?search=Раҳимов')).toHaveLength(2);
      expect(await logs(token, '?search=никто')).toHaveLength(0);
    });

    it('период задаётся календарными датами, обе границы включающие', async () => {
      const { token } = await actor();
      await seed(token);
      const today = new Date().toISOString().slice(0, 10);

      expect(await logs(token, `?from=${today}&to=${today}`)).toHaveLength(2);
      expect(await logs(token, '?from=2020-01-01&to=2020-01-02')).toHaveLength(0);
    });

    it('период наоборот и длиннее года — 400', async () => {
      const { token } = await actor();

      await request(app.getHttpServer())
        .get('/api/v1/admin/logs?from=2026-08-31&to=2026-08-01')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);

      await request(app.getHttpServer())
        .get('/api/v1/admin/logs?from=2020-01-01&to=2026-08-03')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('журнал только читается: дописать строку запросом нельзя', async () => {
      const { token } = await actor();

      await request(app.getHttpServer())
        .post('/api/v1/admin/logs')
        .set('Authorization', `Bearer ${token}`)
        .send({ action: 'Students.Delete' })
        .expect(404);
    });
  });

  // --- Права -----------------------------------------------------------

  describe('доступ', () => {
    it('401 без токена, 403 студенту', async () => {
      await request(app.getHttpServer()).get('/api/v1/admin/logs').expect(401);
      await request(app.getHttpServer())
        .get('/api/v1/admin/logs')
        .set('Authorization', `Bearer ${await studentToken()}`)
        .expect(403);
    });

    it('право на купоны журнала не открывает, и наоборот', async () => {
      const { token: couponsOnly } = await actor(COUPON_CODES);
      const { token: logsOnly } = await actor([VIEW_LOGS]);

      await request(app.getHttpServer())
        .get('/api/v1/admin/logs')
        .set('Authorization', `Bearer ${couponsOnly}`)
        .expect(403);

      await request(app.getHttpServer())
        .get('/api/v1/admin/logs')
        .set('Authorization', `Bearer ${logsOnly}`)
        .expect(200);

      await request(app.getHttpServer())
        .get('/api/v1/coupons')
        .set('Authorization', `Bearer ${logsOnly}`)
        .expect(403);
    });
  });

  it('OpenAPI: журнал описан одним `get` и без методов записи', () => {
    const document = buildOpenApiDocument(app);
    const path = document.paths?.['/api/v1/admin/logs'];

    expect(path).toBeDefined();
    expect(Object.keys(path ?? {})).toEqual(['get']);
  });
});
