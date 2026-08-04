import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountType, DirectoryStatus } from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, SortOrder, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { JobSortField } from 'src/jobs/dto';
import { JobsModule } from 'src/jobs/jobs.module';
import type {
  JobListParams,
  JobRow,
  JobUpdateInput,
  JobWriteInput,
} from 'src/jobs/jobs.repository';
import { JobsRepository } from 'src/jobs/jobs.repository';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { PhoneModule } from 'src/phone/phone.module';
// Лимиты частоты (Фаза 14) навешаны декоратором на эндпоинты auth,
// поэтому guard должен быть в графе. Redis набору не нужен: без клиента
// лимитер ничего не считает.
import { RateLimitModule } from 'src/rate-limit/rate-limit.module';
import { RbacModule } from 'src/rbac/rbac.module';
import { RbacRepository } from 'src/rbac/rbac.repository';
import { buildOpenApiDocument } from 'src/swagger';

/** `{ data }` ответа с ожидаемым типом — тела supertest типизированы как `any`. */
const dataOf = <T>(response: { body: unknown }): T => (response.body as { data: T }).data;
const metaOf = (response: { body: unknown }): { total: number; page: number; limit: number } =>
  (response.body as { meta: { total: number; page: number; limit: number } }).meta;

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

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

/** Совпадение подстроки без учёта регистра — то же, что `mode: 'insensitive'`. */
const contains = (haystack: string | null, needle: string): boolean =>
  haystack !== null && haystack.toLowerCase().includes(needle.toLowerCase());

/**
 * Вакансии в памяти.
 *
 * Отбор, порядок и страница **повторяют правила репозитория**, а не подставляют
 * готовые ответы: иначе набор проверял бы заглушку, а не то, что фильтр `open`
 * пропускает бессрочные вакансии и что поиск идёт по всем четырём текстовым
 * полям (приём набора журнала действий, 0038).
 */
class InMemoryJobsStore {
  private readonly rows = new Map<string, JobRow>();

  seed(overrides: Partial<JobRow> = {}): JobRow {
    const row: JobRow = {
      title: 'Frontend-разработчик',
      company: 'ООО «Ромашка»',
      description: null,
      requirements: null,
      contacts: 'hr@romashka.tj',
      deadline: null,
      status: DirectoryStatus.ACTIVE,
      createdAt: new Date('2026-08-04T10:00:00.000Z'),
      updatedAt: new Date('2026-08-04T10:00:00.000Z'),
      ...overrides,
      id: overrides.id ?? randomUUID(),
    };

    this.rows.set(row.id, row);

    return row;
  }

  get size(): number {
    return this.rows.size;
  }

  findMany(params: JobListParams): Promise<{ rows: JobRow[]; total: number }> {
    const isOpen = (row: JobRow): boolean =>
      row.status === DirectoryStatus.ACTIVE &&
      (row.deadline === null || row.deadline.getTime() >= params.on.getTime());

    const matched = [...this.rows.values()].filter((row) => {
      if (params.status !== undefined && row.status !== params.status) return false;
      if (params.open !== undefined && isOpen(row) !== params.open) return false;

      if (params.search !== undefined) {
        const hit =
          contains(row.title, params.search) ||
          contains(row.company, params.search) ||
          contains(row.description, params.search) ||
          contains(row.requirements, params.search);
        if (!hit) return false;
      }

      return true;
    });

    const direction = params.order === SortOrder.Asc ? 1 : -1;
    matched.sort((a, b) => {
      switch (params.sort) {
        case JobSortField.Title:
          return a.title.localeCompare(b.title) * direction;
        case JobSortField.Company:
          return a.company.localeCompare(b.company) * direction;
        case JobSortField.Deadline: {
          // Бессрочная вакансия уезжает в конец при любом направлении.
          if (a.deadline === null && b.deadline === null) return 0;
          if (a.deadline === null) return 1;
          if (b.deadline === null) return -1;

          return (a.deadline.getTime() - b.deadline.getTime()) * direction;
        }
        default:
          return (a.createdAt.getTime() - b.createdAt.getTime()) * direction;
      }
    });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findById(id: string): Promise<JobRow | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  create(input: JobWriteInput): Promise<JobRow> {
    return Promise.resolve(
      this.seed({
        title: input.title,
        company: input.company,
        description: input.description,
        requirements: input.requirements,
        contacts: input.contacts,
        deadline: input.deadline,
        status: input.status ?? DirectoryStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
  }

  update(id: string, input: JobUpdateInput): Promise<JobRow> {
    const existing = this.rows.get(id);
    if (!existing) throw new Error(`Вакансия ${id} не заведена в хранилище`);

    // `undefined` не трогает колонку — так же, как Prisma.
    const patch = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
    const updated: JobRow = { ...existing, ...patch, updatedAt: new Date() };
    this.rows.set(id, updated);

    return Promise.resolve(updated);
  }

  delete(id: string): Promise<void> {
    this.rows.delete(id);

    return Promise.resolve();
  }
}

interface JobBody {
  id: string;
  title: string;
  company: string;
  description: string | null;
  requirements: string | null;
  contacts: string;
  deadline: string | null;
  status: DirectoryStatus;
  isOpen: boolean;
}

/** Форма кабинета: те же поля минус `status` и `isOpen`. */
type MeJobBody = Omit<JobBody, 'status' | 'isOpen'>;

/** Завтра и вчера от «сегодня» приложения — сроки, зависящие от текущего дня. */
const shiftedIso = (days: number): string => {
  const now = new Date();
  const shifted = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days),
  );

  return shifted.toISOString().slice(0, 10);
};

describe('Вакансии (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryJobsStore;
  let rbac: InMemoryRbacRepository;
  let tokens: TokenService;

  beforeEach(async () => {
    store = new InMemoryJobsStore();
    rbac = new InMemoryRbacRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        PhoneModule,
        // AuthModule нужен целиком: он приносит глобальный `JwtAuthGuard`.
        RateLimitModule,
        AuthModule,
        RbacModule,
        JobsModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
      ],
    })
      .overrideProvider(AuthRepository)
      .useValue({})
      .overrideProvider(JobsRepository)
      .useValue(store)
      .overrideProvider(RbacRepository)
      .useValue(rbac)
      .compile();

    tokens = moduleRef.get(TokenService, { strict: false });

    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  /** Токен сотрудника с перечисленными правами каталога. */
  const staffToken = async (codes: string[]): Promise<string> => {
    const accountId = randomUUID();
    rbac.grant(accountId, codes);
    const { accessToken } = await tokens.issuePair({
      sub: accountId,
      sid: randomUUID(),
      type: AccountType.EMPLOYEE,
    });

    return accessToken;
  };

  const studentToken = async (): Promise<string> =>
    (await tokens.issuePair({ sub: randomUUID(), sid: randomUUID(), type: AccountType.STUDENT }))
      .accessToken;

  const get = (url: string, token: string) =>
    request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);

  const post = (url: string, token: string, body: object) =>
    request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${token}`).send(body);

  const put = (url: string, token: string, body: object) =>
    request(app.getHttpServer()).put(url).set('Authorization', `Bearer ${token}`).send(body);

  const del = (url: string, token: string) =>
    request(app.getHttpServer()).delete(url).set('Authorization', `Bearer ${token}`);

  const VALID = {
    title: 'Frontend-разработчик',
    company: 'ООО «Ромашка»',
    contacts: 'hr@romashka.tj, +992 90 123-45-67',
  };

  // ───────────────────────────── Доступ ─────────────────────────────

  describe('Доступ (ТЗ 3.2)', () => {
    it('без токена — 401 на списке центра и в кабинете студента', async () => {
      await request(app.getHttpServer()).get('/api/v1/jobs').expect(401);
      await request(app.getHttpServer()).get('/api/v1/me/jobs').expect(401);
    });

    it('сотруднику без права `Jobs.Views` список закрыт — 403', async () => {
      const token = await staffToken([]);

      await get('/api/v1/jobs', token).expect(403);
    });

    it('право на просмотр не даёт заводить, править и удалять', async () => {
      const token = await staffToken(['Permission.Jobs.Views']);
      const job = store.seed();

      await post('/api/v1/jobs', token, VALID).expect(403);
      await put(`/api/v1/jobs/${job.id}`, token, { title: 'Senior' }).expect(403);
      await del(`/api/v1/jobs/${job.id}`, token).expect(403);
      expect(store.size).toBe(1);
    });

    it('студенту список центра закрыт — 403: ему адресован `/me/jobs`', async () => {
      const token = await studentToken();

      await get('/api/v1/jobs', token).expect(403);
    });

    it('сотруднику кабинет студента закрыт — 403, даже с полными правами на вакансии', async () => {
      const token = await staffToken([
        'Permission.Jobs.Views',
        'Permission.Jobs.Create',
        'Permission.Jobs.Update',
        'Permission.Jobs.Delete',
      ]);

      await get('/api/v1/me/jobs', token).expect(403);
    });

    it('студенту кабинет открыт **без единого права каталога**', async () => {
      const token = await studentToken();

      await get('/api/v1/me/jobs', token).expect(200);
    });
  });

  // ───────────────────────────── CRUD ─────────────────────────────

  describe('CRUD (ТЗ 5.18)', () => {
    it('заводит вакансию со всеми шестью полями ТЗ', async () => {
      const token = await staffToken(['Permission.Jobs.Create']);

      const response = await post('/api/v1/jobs', token, {
        ...VALID,
        description: 'Кабинет клиента на React',
        requirements: 'React, TypeScript, опыт от года',
        deadline: '2026-11-30',
      }).expect(201);

      expect(dataOf<JobBody>(response)).toMatchObject({
        title: 'Frontend-разработчик',
        company: 'ООО «Ромашка»',
        description: 'Кабинет клиента на React',
        requirements: 'React, TypeScript, опыт от года',
        contacts: 'hr@romashka.tj, +992 90 123-45-67',
        deadline: '2026-11-30',
        status: DirectoryStatus.ACTIVE,
      });
    });

    it('обязательны название, компания и контакты — без каждого 400', async () => {
      const token = await staffToken(['Permission.Jobs.Create']);

      await post('/api/v1/jobs', token, { company: 'К', contacts: 'c@c.tj' }).expect(400);
      await post('/api/v1/jobs', token, { title: 'Т', contacts: 'c@c.tj' }).expect(400);
      await post('/api/v1/jobs', token, { title: 'Т', company: 'ООО К' }).expect(400);
      expect(store.size).toBe(0);
    });

    it('описание, требования и срок необязательны', async () => {
      const token = await staffToken(['Permission.Jobs.Create']);

      const response = await post('/api/v1/jobs', token, VALID).expect(201);

      expect(dataOf<JobBody>(response)).toMatchObject({
        description: null,
        requirements: null,
        deadline: null,
        isOpen: true,
      });
    });

    it('**две вакансии с одним названием у разных компаний** заводятся обе', async () => {
      const token = await staffToken(['Permission.Jobs.Create']);

      await post('/api/v1/jobs', token, { ...VALID, company: 'Первая' }).expect(201);
      await post('/api/v1/jobs', token, { ...VALID, company: 'Вторая' }).expect(201);

      expect(store.size).toBe(2);
    });

    it('та же вакансия у той же компании во второй раз — тоже не конфликт', async () => {
      const token = await staffToken(['Permission.Jobs.Create']);

      await post('/api/v1/jobs', token, VALID).expect(201);
      await post('/api/v1/jobs', token, VALID).expect(201);

      expect(store.size).toBe(2);
    });

    it('400 на срок в неверном формате и на несуществующую дату', async () => {
      const token = await staffToken(['Permission.Jobs.Create']);

      await post('/api/v1/jobs', token, { ...VALID, deadline: '30.11.2026' }).expect(400);
      await post('/api/v1/jobs', token, { ...VALID, deadline: '2026-02-30' }).expect(400);
      expect(store.size).toBe(0);
    });

    it('карточка отдаёт заведённую вакансию, 404 — на чужой идентификатор', async () => {
      const token = await staffToken(['Permission.Jobs.Views']);
      const job = store.seed({ title: 'Тестировщик' });

      const response = await get(`/api/v1/jobs/${job.id}`, token).expect(200);
      expect(dataOf<JobBody>(response)).toMatchObject({ id: job.id, title: 'Тестировщик' });

      await get(`/api/v1/jobs/${randomUUID()}`, token).expect(404);
    });

    it('правка меняет переданное и не трогает остальное', async () => {
      const token = await staffToken(['Permission.Jobs.Update']);
      const job = store.seed({ description: 'Было', deadline: day('2026-11-30') });

      const response = await put(`/api/v1/jobs/${job.id}`, token, {
        title: 'Senior Frontend',
      }).expect(200);

      expect(dataOf<JobBody>(response)).toMatchObject({
        title: 'Senior Frontend',
        company: 'ООО «Ромашка»',
        description: 'Было',
        deadline: '2026-11-30',
      });
    });

    it('пустая строка снимает срок, но контакты стереть нельзя — 400', async () => {
      const token = await staffToken(['Permission.Jobs.Update']);
      const job = store.seed({ deadline: day('2026-11-30') });

      const response = await put(`/api/v1/jobs/${job.id}`, token, { deadline: '' }).expect(200);
      expect(dataOf<JobBody>(response)).toMatchObject({ deadline: null });

      await put(`/api/v1/jobs/${job.id}`, token, { contacts: '' }).expect(400);
      await put(`/api/v1/jobs/${job.id}`, token, { title: '' }).expect(400);
    });

    it('удаление проходит **без единой проверки связей** и отдаёт название', async () => {
      const token = await staffToken(['Permission.Jobs.Delete']);
      const job = store.seed({ title: 'Тестировщик' });

      const response = await del(`/api/v1/jobs/${job.id}`, token).expect(200);

      expect(dataOf<{ id: string; title: string }>(response)).toEqual({
        id: job.id,
        title: 'Тестировщик',
      });
      expect(store.size).toBe(0);
    });

    it('404 на правку и удаление несуществующей вакансии', async () => {
      const token = await staffToken(['Permission.Jobs.Update', 'Permission.Jobs.Delete']);

      await put(`/api/v1/jobs/${randomUUID()}`, token, { title: 'Senior' }).expect(404);
      await del(`/api/v1/jobs/${randomUUID()}`, token).expect(404);
    });

    it('400 на идентификатор не в формате UUID', async () => {
      const token = await staffToken(['Permission.Jobs.Views']);

      await get('/api/v1/jobs/не-uuid', token).expect(400);
    });
  });

  // ───────────────────── Актуальность: статус и срок ─────────────────────

  describe('Актуальность (ТЗ 5.18: «список актуальных вакансий»)', () => {
    it('`isOpen` считается по статусу и сроку: три случая в одном списке', async () => {
      const token = await staffToken(['Permission.Jobs.Views']);
      store.seed({ title: 'Бессрочная' });
      store.seed({ title: 'Просроченная', deadline: day('2020-01-01') });
      store.seed({ title: 'Снятая', status: DirectoryStatus.INACTIVE });

      const response = await get('/api/v1/jobs?sort=title&order=asc', token).expect(200);
      const rows = dataOf<JobBody[]>(response);

      expect(rows.map((row) => [row.title, row.isOpen])).toEqual([
        ['Бессрочная', true],
        ['Просроченная', false],
        ['Снятая', false],
      ]);
    });

    it('срок ровно сегодня — вакансия ещё открыта (граница включающая)', async () => {
      const token = await staffToken(['Permission.Jobs.Views']);
      const job = store.seed({ deadline: day(shiftedIso(0)) });

      const response = await get(`/api/v1/jobs/${job.id}`, token).expect(200);

      expect(dataOf<JobBody>(response)).toMatchObject({ isOpen: true });
    });

    it('срок вчера — вакансия закрыта', async () => {
      const token = await staffToken(['Permission.Jobs.Views']);
      const job = store.seed({ deadline: day(shiftedIso(-1)) });

      const response = await get(`/api/v1/jobs/${job.id}`, token).expect(200);

      expect(dataOf<JobBody>(response)).toMatchObject({ isOpen: false });
    });

    it('`?open=true` оставляет бессрочные и не оставляет просроченные', async () => {
      const token = await staffToken(['Permission.Jobs.Views']);
      store.seed({ title: 'Бессрочная' });
      store.seed({ title: 'Со сроком', deadline: day(shiftedIso(30)) });
      store.seed({ title: 'Просроченная', deadline: day('2020-01-01') });
      store.seed({ title: 'Снятая', status: DirectoryStatus.INACTIVE });

      const response = await get('/api/v1/jobs?open=true&sort=title&order=asc', token).expect(200);

      expect(dataOf<JobBody[]>(response).map((row) => row.title)).toEqual([
        'Бессрочная',
        'Со сроком',
      ]);
    });

    it('`?open=false` оставляет просроченные и снятые', async () => {
      const token = await staffToken(['Permission.Jobs.Views']);
      store.seed({ title: 'Бессрочная' });
      store.seed({ title: 'Просроченная', deadline: day('2020-01-01') });
      store.seed({ title: 'Снятая', status: DirectoryStatus.INACTIVE });

      const response = await get('/api/v1/jobs?open=false&sort=title&order=asc', token).expect(200);

      expect(dataOf<JobBody[]>(response).map((row) => row.title)).toEqual([
        'Просроченная',
        'Снятая',
      ]);
    });

    it('`status` и `open` — разные фильтры: `ACTIVE` бывает просроченной', async () => {
      const token = await staffToken(['Permission.Jobs.Views']);
      store.seed({ title: 'Просроченная', deadline: day('2020-01-01') });

      const byStatus = await get(`/api/v1/jobs?status=${DirectoryStatus.ACTIVE}`, token).expect(
        200,
      );
      const byOpen = await get('/api/v1/jobs?open=true', token).expect(200);

      expect(metaOf(byStatus).total).toBe(1);
      expect(metaOf(byOpen).total).toBe(0);
    });
  });

  // ───────────────────────── Список: поиск и порядок ─────────────────────────

  describe('Список (ТЗ 3.5)', () => {
    it('поиск идёт по названию, компании, описанию и требованиям', async () => {
      const token = await staffToken(['Permission.Jobs.Views']);
      store.seed({ title: 'React-разработчик', company: 'A' });
      store.seed({ title: 'Тестировщик', company: 'React Labs' });
      store.seed({ title: 'Аналитик', company: 'B', description: 'Пишем на React' });
      store.seed({ title: 'Верстальщик', company: 'C', requirements: 'React приветствуется' });
      store.seed({ title: 'Бухгалтер', company: 'D' });

      const response = await get('/api/v1/jobs?search=react', token).expect(200);

      expect(metaOf(response).total).toBe(4);
    });

    it('поиск без учёта регистра', async () => {
      const token = await staffToken(['Permission.Jobs.Views']);
      store.seed({ title: 'Frontend-разработчик' });

      await get('/api/v1/jobs?search=FRONTEND', token).expect(200);
      expect(metaOf(await get('/api/v1/jobs?search=FRONTEND', token)).total).toBe(1);
    });

    it('по умолчанию свежие сверху: вакансия — объявление, а не строка каталога', async () => {
      const token = await staffToken(['Permission.Jobs.Views']);
      store.seed({ title: 'Старая', createdAt: new Date('2026-01-01T00:00:00.000Z') });
      store.seed({ title: 'Новая', createdAt: new Date('2026-08-01T00:00:00.000Z') });

      const response = await get('/api/v1/jobs', token).expect(200);

      expect(dataOf<JobBody[]>(response).map((row) => row.title)).toEqual(['Новая', 'Старая']);
    });

    it('сортировка по сроку: бессрочная уезжает в конец при любом направлении', async () => {
      const token = await staffToken(['Permission.Jobs.Views']);
      store.seed({ title: 'Ноябрь', deadline: day('2026-11-30') });
      store.seed({ title: 'Сентябрь', deadline: day('2026-09-01') });
      store.seed({ title: 'Бессрочная' });

      const asc = await get('/api/v1/jobs?sort=deadline&order=asc', token).expect(200);
      const desc = await get('/api/v1/jobs?sort=deadline&order=desc', token).expect(200);

      expect(dataOf<JobBody[]>(asc).map((row) => row.title)).toEqual([
        'Сентябрь',
        'Ноябрь',
        'Бессрочная',
      ]);
      expect(dataOf<JobBody[]>(desc).map((row) => row.title)).toEqual([
        'Ноябрь',
        'Сентябрь',
        'Бессрочная',
      ]);
    });

    it('страница режется, а `meta.total` считает весь набор', async () => {
      const token = await staffToken(['Permission.Jobs.Views']);
      for (let i = 0; i < 5; i += 1) store.seed({ title: `Вакансия ${String(i)}` });

      const response = await get('/api/v1/jobs?page=2&limit=2', token).expect(200);

      expect(dataOf<JobBody[]>(response)).toHaveLength(2);
      expect(metaOf(response)).toMatchObject({ total: 5, page: 2, limit: 2 });
    });

    it('400 на неизвестное поле сортировки: свободная строка в `orderBy` не уходит', async () => {
      const token = await staffToken(['Permission.Jobs.Views']);

      await get('/api/v1/jobs?sort=contacts', token).expect(400);
    });
  });

  // ───────────────────────── Кабинет студента ─────────────────────────

  describe('Кабинет студента (`GET /me/jobs`)', () => {
    it('студент видит только актуальные вакансии', async () => {
      const token = await studentToken();
      store.seed({ title: 'Бессрочная' });
      store.seed({ title: 'До конца месяца', deadline: day(shiftedIso(20)) });
      store.seed({ title: 'Просроченная', deadline: day('2020-01-01') });
      store.seed({ title: 'Снятая', status: DirectoryStatus.INACTIVE });

      const response = await get('/api/v1/me/jobs?sort=title&order=asc', token).expect(200);

      expect(dataOf<MeJobBody[]>(response).map((row) => row.title)).toEqual([
        'Бессрочная',
        'До конца месяца',
      ]);
      expect(metaOf(response).total).toBe(2);
    });

    it('**снятую вакансию не показать никакими параметрами запроса**', async () => {
      const token = await studentToken();
      store.seed({ title: 'Снятая', status: DirectoryStatus.INACTIVE });
      store.seed({ title: 'Просроченная', deadline: day('2020-01-01') });

      // Отбор задан маршрутом, а не фильтром: `open` и `status` в этом DTO нет,
      // а `forbidNonWhitelisted` глобального `ValidationPipe` отбивает лишнее.
      await get('/api/v1/me/jobs?open=false', token).expect(400);
      await get(`/api/v1/me/jobs?status=${DirectoryStatus.INACTIVE}`, token).expect(400);

      const response = await get('/api/v1/me/jobs', token).expect(200);
      expect(metaOf(response).total).toBe(0);
    });

    it('в форме кабинета нет `status` и `isOpen`, но есть срок и контакты', async () => {
      const token = await studentToken();
      store.seed({ deadline: day(shiftedIso(20)), description: 'Про React' });

      const [row] = dataOf<MeJobBody[]>(await get('/api/v1/me/jobs', token).expect(200));

      expect(row).not.toHaveProperty('status');
      expect(row).not.toHaveProperty('isOpen');
      expect(row).toMatchObject({
        title: 'Frontend-разработчик',
        company: 'ООО «Ромашка»',
        contacts: 'hr@romashka.tj',
        description: 'Про React',
        deadline: shiftedIso(20),
      });
    });

    it('поиск и страница в кабинете работают', async () => {
      const token = await studentToken();
      store.seed({ title: 'React-разработчик' });
      store.seed({ title: 'Бухгалтер' });

      const response = await get('/api/v1/me/jobs?search=react', token).expect(200);

      expect(metaOf(response).total).toBe(1);
    });

    it('кабинет только читает: `POST /me/jobs` не существует (404)', async () => {
      const token = await studentToken();

      await post('/api/v1/me/jobs', token, VALID).expect(404);
    });

    it('вакансия, снятая сотрудником, тут же исчезает из кабинета', async () => {
      const staff = await staffToken(['Permission.Jobs.Update']);
      const student = await studentToken();
      const job = store.seed();

      expect(metaOf(await get('/api/v1/me/jobs', student)).total).toBe(1);

      await put(`/api/v1/jobs/${job.id}`, staff, {
        status: DirectoryStatus.INACTIVE,
      }).expect(200);

      expect(metaOf(await get('/api/v1/me/jobs', student)).total).toBe(0);
      // В списке центра она осталась: это рабочий список, а не витрина.
      const staffViews = await staffToken(['Permission.Jobs.Views']);
      expect(metaOf(await get('/api/v1/jobs', staffViews)).total).toBe(1);
    });
  });

  // ───────────────────────────── OpenAPI ─────────────────────────────

  describe('OpenAPI', () => {
    it('описывает оба маршрута ТЗ и кабинет студента', () => {
      const paths = buildOpenApiDocument(app).paths;

      expect(Object.keys(paths)).toEqual(
        expect.arrayContaining(['/api/v1/jobs', '/api/v1/jobs/{id}', '/api/v1/me/jobs']),
      );
    });

    it('создание отвечает 201 и не 200', () => {
      const paths = buildOpenApiDocument(app).paths;

      expect(paths['/api/v1/jobs']?.post?.responses['201']).toBeDefined();
      expect(paths['/api/v1/jobs']?.post?.responses['200']).toBeUndefined();
    });

    it('кабинет студента описан **одним `get`** — записи в нём нет', () => {
      const me = buildOpenApiDocument(app).paths['/api/v1/me/jobs'];

      expect(me?.get).toBeDefined();
      expect(me?.post).toBeUndefined();
      expect(me?.put).toBeUndefined();
      expect(me?.delete).toBeUndefined();
    });
  });
});
