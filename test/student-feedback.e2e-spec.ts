import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountType } from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, SortOrder, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { PhoneModule } from 'src/phone/phone.module';
// Лимиты частоты (Фаза 14) навешаны декоратором на эндпоинты auth,
// поэтому guard должен быть в графе. Redis набору не нужен: без клиента
// лимитер ничего не считает.
import { RateLimitModule } from 'src/rate-limit/rate-limit.module';
import { RbacModule } from 'src/rbac/rbac.module';
import { RbacRepository } from 'src/rbac/rbac.repository';
import type {
  CreateFeedbackInput,
  FeedbackListParams,
  FeedbackRow,
} from 'src/student-feedback/student-feedback.repository';
import { StudentFeedbackRepository } from 'src/student-feedback/student-feedback.repository';
import { StudentFeedbackModule } from 'src/student-feedback/student-feedback.module';
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

interface StoredEmployee {
  id: string;
  accountId: string;
  firstName: string;
  lastName: string;
}

/**
 * Заметки, студенты и сотрудники вместе: автор берётся по аккаунту вызывающего,
 * а заметка адресуется парой «студент + заметка». Несогласованные заглушки
 * проверяли бы не то поведение, которое даёт БД.
 */
class InMemoryFeedbackStore {
  readonly students = new Set<string>();
  readonly employeesByAccount = new Map<string, StoredEmployee>();
  readonly feedback = new Map<string, FeedbackRow & { studentId: string }>();

  addStudent(): string {
    const id = randomUUID();
    this.students.add(id);

    return id;
  }

  addEmployee(accountId: string, firstName = 'Фаррух', lastName = 'Раҳимов'): StoredEmployee {
    const employee: StoredEmployee = { id: randomUUID(), accountId, firstName, lastName };
    this.employeesByAccount.set(accountId, employee);

    return employee;
  }

  // ─── StudentFeedbackRepository ───

  findMany(params: FeedbackListParams): Promise<{ rows: FeedbackRow[]; total: number }> {
    const search = params.search?.toLowerCase();

    const matched = [...this.feedback.values()]
      .filter((row) => row.studentId === params.studentId)
      .filter((row) => params.authorId === undefined || row.author?.id === params.authorId)
      .filter((row) => search === undefined || row.text.toLowerCase().includes(search))
      .sort((a, b) => {
        const asc = a.createdAt.getTime() - b.createdAt.getTime();

        return params.order === SortOrder.Asc ? asc : -asc;
      });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findStudent(id: string): Promise<{ id: string } | null> {
    return Promise.resolve(this.students.has(id) ? { id } : null);
  }

  findEmployeeByAccount(accountId: string): Promise<{ id: string } | null> {
    const employee = this.employeesByAccount.get(accountId);

    return Promise.resolve(employee ? { id: employee.id } : null);
  }

  findOne(studentId: string, id: string): Promise<FeedbackRow | null> {
    const row = this.feedback.get(id);

    return Promise.resolve(row && row.studentId === studentId ? row : null);
  }

  create(input: CreateFeedbackInput): Promise<FeedbackRow> {
    const author =
      input.authorId === null
        ? null
        : ([...this.employeesByAccount.values()].find(({ id }) => id === input.authorId) ?? null);

    const row = {
      id: randomUUID(),
      studentId: input.studentId,
      text: input.text,
      // Время создания разводится по номеру записи: иначе порядок «свежие
      // сверху» зависел бы от того, уложились ли вставки в одну миллисекунду.
      createdAt: new Date(Date.now() + this.feedback.size),
      author:
        author === null
          ? null
          : { id: author.id, firstName: author.firstName, lastName: author.lastName },
    };
    this.feedback.set(row.id, row);

    return Promise.resolve(row);
  }

  delete(id: string): Promise<void> {
    this.feedback.delete(id);

    return Promise.resolve();
  }
}

interface FeedbackBody {
  id: string;
  text: string;
  author: { id: string; firstName: string; lastName: string } | null;
  createdAt: string;
}

describe('Студенты: обратная связь (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryFeedbackStore;
  let rbac: InMemoryRbacRepository;
  let tokens: TokenService;

  beforeEach(async () => {
    store = new InMemoryFeedbackStore();
    rbac = new InMemoryRbacRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        PhoneModule,
        RateLimitModule,
        AuthModule,
        RbacModule,
        StudentFeedbackModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
      ],
    })
      // AuthModule нужен целиком: он приносит глобальный `JwtAuthGuard`.
      .overrideProvider(AuthRepository)
      .useValue({})
      .overrideProvider(RbacRepository)
      .useValue(rbac)
      .overrideProvider(StudentFeedbackRepository)
      .useValue(store)
      .compile();

    tokens = moduleRef.get(TokenService, { strict: false });

    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  /** Сотрудник с правами и профилем — автор заметок. */
  const actor = async (
    codes: string[],
    profile?: { firstName: string; lastName: string },
  ): Promise<string> => {
    const accountId = randomUUID();
    rbac.grant(accountId, codes);
    if (profile) store.addEmployee(accountId, profile.firstName, profile.lastName);
    else store.addEmployee(accountId);

    return (
      await tokens.issuePair({ sub: accountId, sid: randomUUID(), type: AccountType.EMPLOYEE })
    ).accessToken;
  };

  const studentToken = async (): Promise<string> =>
    (await tokens.issuePair({ sub: randomUUID(), sid: randomUUID(), type: AccountType.STUDENT }))
      .accessToken;

  const get = (url: string, token: string) =>
    request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);

  const post = (url: string, token: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${token}`).send(body);

  const del = (url: string, token: string) =>
    request(app.getHttpServer()).delete(url).set('Authorization', `Bearer ${token}`);

  const feedbackUrl = (studentId: string) => `/api/v1/students/${studentId}/feedback`;

  describe('Доступ', () => {
    it('без токена — 401', async () => {
      await request(app.getHttpServer()).get(feedbackUrl(store.addStudent())).expect(401);
    });

    it('студент чужие заметки о себе не читает — 403 (ТЗ 3.2)', async () => {
      await get(feedbackUrl(store.addStudent()), await studentToken()).expect(403);
    });

    it('сотрудник без прав — 403', async () => {
      await get(feedbackUrl(store.addStudent()), await actor([])).expect(403);
    });

    it('право на просмотр студентов открывает ленту, но не запись', async () => {
      const student = store.addStudent();
      const token = await actor(['Permission.Students.Views']);

      await get(feedbackUrl(student), token).expect(200);
      await post(feedbackUrl(student), token, { text: 'Хорошо работает' }).expect(403);
    });

    it('право на правку карточки заметку не добавляет', async () => {
      const student = store.addStudent();

      await post(feedbackUrl(student), await actor(['Permission.Students.Update']), {
        text: 'Хорошо работает',
      }).expect(403);
    });

    it('удаление требует того же права, что и добавление', async () => {
      const student = store.addStudent();
      const author = await actor(['Permission.Students.Feedback']);
      const created = await post(feedbackUrl(student), author, { text: 'Заметка' }).expect(201);
      const id = dataOf<FeedbackBody>(created).id;

      await del(`${feedbackUrl(student)}/${id}`, await actor(['Permission.Students.Views'])).expect(
        403,
      );
      await del(`${feedbackUrl(student)}/${id}`, author).expect(200);
    });
  });

  describe('Добавление (ТЗ 5.3: Feedback)', () => {
    it('подписывает заметку сотрудником из токена', async () => {
      const student = store.addStudent();
      const token = await actor(['Permission.Students.Feedback'], {
        firstName: 'Фаррух',
        lastName: 'Раҳимов',
      });

      const response = await post(feedbackUrl(student), token, {
        text: 'Пропустил две недели по болезни, догнал программу самостоятельно.',
      }).expect(201);

      expect(dataOf<FeedbackBody>(response)).toMatchObject({
        text: 'Пропустил две недели по болезни, догнал программу самостоятельно.',
        author: { firstName: 'Фаррух', lastName: 'Раҳимов' },
      });
    });

    it('подписаться чужим именем нельзя: автор в теле не принимается', async () => {
      const student = store.addStudent();

      await post(feedbackUrl(student), await actor(['Permission.Students.Feedback']), {
        text: 'Заметка',
        authorId: randomUUID(),
      }).expect(400);
    });

    it('400 на пустой текст и на отписку в два символа', async () => {
      const student = store.addStudent();
      const token = await actor(['Permission.Students.Feedback']);

      await post(feedbackUrl(student), token, {}).expect(400);
      await post(feedbackUrl(student), token, { text: 'ок' }).expect(400);
    });

    it('404 на неизвестного студента и 400 на не-UUID в пути', async () => {
      const token = await actor(['Permission.Students.Feedback']);

      await post(feedbackUrl(randomUUID()), token, { text: 'Заметка' }).expect(404);
      await post(feedbackUrl('не-uuid'), token, { text: 'Заметка' }).expect(400);
    });
  });

  describe('Лента', () => {
    it('отдаёт заметки свежими сверху с `{ data, meta }`', async () => {
      const student = store.addStudent();
      const token = await actor(['Permission.Students.Feedback', 'Permission.Students.Views']);

      await post(feedbackUrl(student), token, { text: 'Первая заметка' }).expect(201);
      await post(feedbackUrl(student), token, { text: 'Вторая заметка' }).expect(201);

      const response = await get(feedbackUrl(student), token).expect(200);
      const body = response.body as { data: FeedbackBody[]; meta: { total: number } };

      expect(body.meta).toMatchObject({ total: 2, page: 1, limit: 20 });
      expect(body.data.map(({ text }) => text)).toEqual(['Вторая заметка', 'Первая заметка']);
    });

    it('заметки соседнего студента в ленту не попадают', async () => {
      const student = store.addStudent();
      const neighbour = store.addStudent();
      const token = await actor(['Permission.Students.Feedback', 'Permission.Students.Views']);

      await post(feedbackUrl(student), token, { text: 'Про первого' }).expect(201);
      await post(feedbackUrl(neighbour), token, { text: 'Про второго' }).expect(201);

      const response = await get(feedbackUrl(student), token).expect(200);

      expect((response.body as { data: FeedbackBody[] }).data.map(({ text }) => text)).toEqual([
        'Про первого',
      ]);
    });

    it('фильтр по автору и поиск по тексту', async () => {
      const student = store.addStudent();
      const first = await actor(['Permission.Students.Feedback', 'Permission.Students.Views'], {
        firstName: 'Фаррух',
        lastName: 'Раҳимов',
      });
      const second = await actor(['Permission.Students.Feedback', 'Permission.Students.Views'], {
        firstName: 'Заррина',
        lastName: 'Сафарова',
      });

      const mine = await post(feedbackUrl(student), first, { text: 'Догнал программу' });
      await post(feedbackUrl(student), second, { text: 'Опоздал на экзамен' }).expect(201);

      const authorId = dataOf<FeedbackBody>(mine).author?.id ?? '';
      const filtered = await get(`${feedbackUrl(student)}?authorId=${authorId}`, first).expect(200);
      expect((filtered.body as { data: FeedbackBody[] }).data.map(({ text }) => text)).toEqual([
        'Догнал программу',
      ]);

      const searched = await get(`${feedbackUrl(student)}?search=экзамен`, first).expect(200);
      expect((searched.body as { data: FeedbackBody[] }).data.map(({ text }) => text)).toEqual([
        'Опоздал на экзамен',
      ]);
    });

    it('400 на неизвестное поле сортировки', async () => {
      const student = store.addStudent();

      await get(
        `${feedbackUrl(student)}?sort=text`,
        await actor(['Permission.Students.Views']),
      ).expect(400);
    });

    it('404 на неизвестного студента', async () => {
      await get(feedbackUrl(randomUUID()), await actor(['Permission.Students.Views'])).expect(404);
    });
  });

  describe('Удаление', () => {
    it('убирает заметку и называет её начало', async () => {
      const student = store.addStudent();
      const token = await actor(['Permission.Students.Feedback', 'Permission.Students.Views']);
      const created = await post(feedbackUrl(student), token, { text: 'Ошибочная заметка' });
      const id = dataOf<FeedbackBody>(created).id;

      const response = await del(`${feedbackUrl(student)}/${id}`, token).expect(200);
      expect(dataOf<{ id: string; text: string }>(response)).toEqual({
        id,
        text: 'Ошибочная заметка',
      });

      const list = await get(feedbackUrl(student), token).expect(200);
      expect((list.body as { data: FeedbackBody[] }).data).toHaveLength(0);
    });

    it('404 на заметку о другом студенте', async () => {
      const student = store.addStudent();
      const neighbour = store.addStudent();
      const token = await actor(['Permission.Students.Feedback']);
      const created = await post(feedbackUrl(neighbour), token, { text: 'Про соседа' });
      const id = dataOf<FeedbackBody>(created).id;

      await del(`${feedbackUrl(student)}/${id}`, token).expect(404);
    });

    it('404 на повторное удаление', async () => {
      const student = store.addStudent();
      const token = await actor(['Permission.Students.Feedback']);
      const created = await post(feedbackUrl(student), token, { text: 'Заметка' });
      const id = dataOf<FeedbackBody>(created).id;

      await del(`${feedbackUrl(student)}/${id}`, token).expect(200);
      await del(`${feedbackUrl(student)}/${id}`, token).expect(404);
    });
  });

  describe('OpenAPI', () => {
    it('пути заметок описаны, добавление отвечает 201', () => {
      const document = buildOpenApiDocument(app);

      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/students/{studentId}/feedback',
          '/api/v1/students/{studentId}/feedback/{feedbackId}',
        ]),
      );

      const create = document.paths['/api/v1/students/{studentId}/feedback']?.post;
      expect(create?.responses['201']).toBeDefined();
      expect(create?.responses['200']).toBeUndefined();
    });
  });
});
