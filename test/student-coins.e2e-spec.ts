import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountType, CoinSource } from '@prisma/client';
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
import { CoinSortField } from 'src/student-coins/dto';
import type {
  AwardCoinsInput,
  CoinListParams,
  CoinTransactionRow,
} from 'src/student-coins/student-coins.repository';
import { StudentCoinsRepository } from 'src/student-coins/student-coins.repository';
import { StudentCoinsModule } from 'src/student-coins/student-coins.module';
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
 * Коины, студенты и сотрудники вместе: баланс равен сумме начислений, а автор
 * берётся по аккаунту вызывающего. Раздельные заглушки позволили бы балансу
 * разойтись с историей — то самое, чего в БД не допускает транзакция.
 */
class InMemoryCoinsStore {
  readonly students = new Map<string, { id: string; firstName: string; lastName: string }>();
  readonly employeesByAccount = new Map<string, StoredEmployee>();
  readonly transactions = new Map<string, CoinTransactionRow>();
  readonly balances = new Map<string, number>();

  addStudent(lastName = 'Каримова', firstName = 'Нигина'): string {
    const id = randomUUID();
    this.students.set(id, { id, firstName, lastName });

    return id;
  }

  addEmployee(accountId: string, firstName = 'Фаррух', lastName = 'Раҳимов'): StoredEmployee {
    const employee: StoredEmployee = { id: randomUUID(), accountId, firstName, lastName };
    this.employeesByAccount.set(accountId, employee);

    return employee;
  }

  /** Автоначисление по неделе журнала — чтобы проверить фильтр по источнику. */
  addWeekAward(studentId: string, amount: number, weekNumber: number): void {
    const row: CoinTransactionRow = {
      id: randomUUID(),
      studentId,
      amount,
      reason: `Итог недели ${String(weekNumber)}: ${String(90 + amount)} баллов`,
      source: CoinSource.WEEK_RESULT,
      createdAt: new Date(Date.now() + this.transactions.size),
      author: null,
      week: { id: randomUUID(), groupId: randomUUID(), weekNumber },
    };
    this.transactions.set(row.id, row);
    this.balances.set(studentId, (this.balances.get(studentId) ?? 0) + amount);
  }

  // ─── StudentCoinsRepository ───

  findMany(params: CoinListParams): Promise<{ rows: CoinTransactionRow[]; total: number }> {
    const matched = [...this.transactions.values()]
      .filter((row) => row.studentId === params.studentId)
      .filter((row) => params.source === undefined || row.source === params.source)
      .sort((a, b) => {
        const asc =
          params.sort === CoinSortField.Amount
            ? a.amount - b.amount
            : a.createdAt.getTime() - b.createdAt.getTime();

        return params.order === SortOrder.Asc ? asc : -asc;
      });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findStudent(id: string): Promise<{ id: string; firstName: string; lastName: string } | null> {
    return Promise.resolve(this.students.get(id) ?? null);
  }

  findEmployeeByAccount(accountId: string): Promise<{ id: string } | null> {
    const employee = this.employeesByAccount.get(accountId);

    return Promise.resolve(employee ? { id: employee.id } : null);
  }

  findBalance(studentId: string): Promise<number> {
    return Promise.resolve(this.balances.get(studentId) ?? 0);
  }

  award(input: AwardCoinsInput): Promise<{ row: CoinTransactionRow; balance: number }> {
    const author =
      input.authorId === null
        ? null
        : ([...this.employeesByAccount.values()].find(({ id }) => id === input.authorId) ?? null);

    const row: CoinTransactionRow = {
      id: randomUUID(),
      studentId: input.studentId,
      amount: input.amount,
      reason: input.reason,
      source: input.source,
      // Время разводится по номеру записи: иначе порядок «свежие сверху»
      // зависел бы от того, уложились ли вставки в одну миллисекунду.
      createdAt: new Date(Date.now() + this.transactions.size),
      author:
        author === null
          ? null
          : { id: author.id, firstName: author.firstName, lastName: author.lastName },
      week: null,
    };
    this.transactions.set(row.id, row);

    const balance = (this.balances.get(input.studentId) ?? 0) + input.amount;
    this.balances.set(input.studentId, balance);

    return Promise.resolve({ row, balance });
  }
}

interface CoinBody {
  id: string;
  amount: number;
  reason: string;
  source: CoinSource;
  week: { weekNumber: number } | null;
  author: { firstName: string; lastName: string } | null;
  createdAt: string;
}

describe('Коины студента (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryCoinsStore;
  let rbac: InMemoryRbacRepository;
  let tokens: TokenService;

  beforeEach(async () => {
    store = new InMemoryCoinsStore();
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
        StudentCoinsModule,
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
      .overrideProvider(StudentCoinsRepository)
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

  const coinsUrl = (studentId: string) => `/api/v1/students/${studentId}/coins`;

  describe('Доступ', () => {
    it('без токена — 401', async () => {
      await request(app.getHttpServer()).get(coinsUrl(store.addStudent())).expect(401);
    });

    it('студент чужой баланс не читает — 403 (ТЗ 3.2)', async () => {
      await get(coinsUrl(store.addStudent()), await studentToken()).expect(403);
    });

    it('сотрудник без прав — 403', async () => {
      await get(coinsUrl(store.addStudent()), await actor([])).expect(403);
    });

    it('право на просмотр баланса не даёт начислять', async () => {
      const student = store.addStudent();
      const token = await actor(['Permission.Coins.Views']);

      await get(coinsUrl(student), token).expect(200);
      await post(coinsUrl(student), token, { amount: 3, reason: 'Активность' }).expect(403);
    });

    it('право на карточки студентов коины не открывает', async () => {
      await get(coinsUrl(store.addStudent()), await actor(['Permission.Students.Views'])).expect(
        403,
      );
    });
  });

  describe('Ручное начисление (ТЗ 5.9)', () => {
    it('начисляет с причиной, подписывает автором из токена и растит баланс', async () => {
      const student = store.addStudent();
      const token = await actor(['Permission.Coins.Create'], {
        firstName: 'Фаррух',
        lastName: 'Раҳимов',
      });

      const response = await post(coinsUrl(student), token, {
        amount: 3,
        reason: 'Помог однокурсникам с проектом',
      }).expect(201);

      expect(dataOf<{ transaction: CoinBody; balance: number }>(response)).toMatchObject({
        balance: 3,
        transaction: {
          amount: 3,
          reason: 'Помог однокурсникам с проектом',
          source: CoinSource.MANUAL,
          author: { firstName: 'Фаррух', lastName: 'Раҳимов' },
        },
      });
    });

    it('баланс складывается из начислений', async () => {
      const student = store.addStudent();
      const token = await actor(['Permission.Coins.Create', 'Permission.Coins.Views']);

      await post(coinsUrl(student), token, { amount: 3, reason: 'Первое' }).expect(201);
      const second = await post(coinsUrl(student), token, { amount: 5, reason: 'Второе' }).expect(
        201,
      );

      expect(dataOf<{ balance: number }>(second).balance).toBe(8);

      const list = await get(coinsUrl(student), token).expect(200);
      expect((list.body as { meta: { balance: number } }).meta.balance).toBe(8);
    });

    it('списание запрещено: ноль и отрицательное — 400', async () => {
      // ТЗ 5.9 прямо запрещает списание, поэтому отрицательной строки в истории
      // не бывает по устройству формы, а не по забытой проверке.
      const student = store.addStudent();
      const token = await actor(['Permission.Coins.Create']);

      await post(coinsUrl(student), token, { amount: 0, reason: 'Штраф' }).expect(400);
      await post(coinsUrl(student), token, { amount: -5, reason: 'Штраф' }).expect(400);
    });

    it('400 без причины, на отписку в два символа и на дробную сумму', async () => {
      const student = store.addStudent();
      const token = await actor(['Permission.Coins.Create']);

      await post(coinsUrl(student), token, { amount: 3 }).expect(400);
      await post(coinsUrl(student), token, { amount: 3, reason: 'ок' }).expect(400);
      await post(coinsUrl(student), token, { amount: 1.5, reason: 'Активность' }).expect(400);
    });

    it('400 на лишнее поле: источник и автор в теле не принимаются', async () => {
      const student = store.addStudent();
      const token = await actor(['Permission.Coins.Create']);

      await post(coinsUrl(student), token, {
        amount: 3,
        reason: 'Активность',
        source: 'WEEK_RESULT',
      }).expect(400);
      await post(coinsUrl(student), token, {
        amount: 3,
        reason: 'Активность',
        authorId: randomUUID(),
      }).expect(400);
    });

    it('404 на неизвестного студента и 400 на не-UUID в пути', async () => {
      const token = await actor(['Permission.Coins.Create']);

      await post(coinsUrl(randomUUID()), token, { amount: 1, reason: 'Активность' }).expect(404);
      await post(coinsUrl('не-uuid'), token, { amount: 1, reason: 'Активность' }).expect(400);
    });
  });

  describe('Баланс и история', () => {
    it('отдаёт `{ data, meta }` с балансом в meta, свежие сверху', async () => {
      const student = store.addStudent();
      const token = await actor(['Permission.Coins.Create', 'Permission.Coins.Views']);

      await post(coinsUrl(student), token, { amount: 3, reason: 'Первое' }).expect(201);
      await post(coinsUrl(student), token, { amount: 5, reason: 'Второе' }).expect(201);

      const response = await get(coinsUrl(student), token).expect(200);
      const body = response.body as { data: CoinBody[]; meta: { total: number; balance: number } };

      expect(body.meta).toMatchObject({ total: 2, page: 1, limit: 20, balance: 8 });
      expect(body.data.map(({ reason }) => reason)).toEqual(['Второе', 'Первое']);
    });

    it('пустая история отдаёт нулевой баланс, а не отсутствие поля', async () => {
      const student = store.addStudent();

      const response = await get(coinsUrl(student), await actor(['Permission.Coins.Views'])).expect(
        200,
      );
      const body = response.body as { data: CoinBody[]; meta: { balance: number } };

      expect(body.data).toHaveLength(0);
      expect(body.meta.balance).toBe(0);
    });

    it('начисления соседнего студента в историю не попадают', async () => {
      const student = store.addStudent('Каримова');
      const neighbour = store.addStudent('Ахмадов');
      const token = await actor(['Permission.Coins.Create', 'Permission.Coins.Views']);

      await post(coinsUrl(student), token, { amount: 3, reason: 'Своё' }).expect(201);
      await post(coinsUrl(neighbour), token, { amount: 5, reason: 'Чужое' }).expect(201);

      const response = await get(coinsUrl(student), token).expect(200);
      const body = response.body as { data: CoinBody[]; meta: { balance: number } };

      expect(body.data.map(({ reason }) => reason)).toEqual(['Своё']);
      expect(body.meta.balance).toBe(3);
    });

    it('фильтр по источнику разделяет ручные и автоматические начисления', async () => {
      const student = store.addStudent();
      const token = await actor(['Permission.Coins.Create', 'Permission.Coins.Views']);

      store.addWeekAward(student, 5, 3);
      await post(coinsUrl(student), token, { amount: 2, reason: 'Активность' }).expect(201);

      const auto = await get(`${coinsUrl(student)}?source=WEEK_RESULT`, token).expect(200);
      const autoBody = auto.body as { data: CoinBody[] };

      expect(autoBody.data).toHaveLength(1);
      expect(autoBody.data[0]).toMatchObject({
        source: CoinSource.WEEK_RESULT,
        author: null,
        week: { weekNumber: 3 },
      });

      const manual = await get(`${coinsUrl(student)}?source=MANUAL`, token).expect(200);
      expect((manual.body as { data: CoinBody[] }).data).toHaveLength(1);
    });

    it('сортировка по сумме и окно страницы', async () => {
      const student = store.addStudent();
      const token = await actor(['Permission.Coins.Create', 'Permission.Coins.Views']);

      await post(coinsUrl(student), token, { amount: 1, reason: 'Первое' }).expect(201);
      await post(coinsUrl(student), token, { amount: 9, reason: 'Второе' }).expect(201);

      const sorted = await get(`${coinsUrl(student)}?sort=amount&order=asc`, token).expect(200);
      expect((sorted.body as { data: CoinBody[] }).data.map(({ amount }) => amount)).toEqual([
        1, 9,
      ]);

      const paged = await get(`${coinsUrl(student)}?limit=1&page=2`, token).expect(200);
      const body = paged.body as { data: CoinBody[]; meta: { total: number; totalPages: number } };
      expect(body.data).toHaveLength(1);
      expect(body.meta).toMatchObject({ total: 2, totalPages: 2 });
    });

    it('400 на неизвестное поле сортировки и неизвестный источник', async () => {
      const student = store.addStudent();
      const token = await actor(['Permission.Coins.Views']);

      await get(`${coinsUrl(student)}?sort=reason`, token).expect(400);
      await get(`${coinsUrl(student)}?source=GIFT`, token).expect(400);
    });

    it('404 на неизвестного студента', async () => {
      await get(coinsUrl(randomUUID()), await actor(['Permission.Coins.Views'])).expect(404);
    });
  });

  describe('OpenAPI', () => {
    it('путь коинов описан, начисление отвечает 201, баланс лежит в meta', () => {
      const document = buildOpenApiDocument(app);

      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining(['/api/v1/students/{studentId}/coins']),
      );

      const path = document.paths['/api/v1/students/{studentId}/coins'];
      expect(path?.post?.responses['201']).toBeDefined();
      expect(path?.post?.responses['200']).toBeUndefined();

      const list = path?.get?.responses['200'] as unknown as {
        content: {
          'application/json': {
            schema: { properties: { meta: { properties: Record<string, unknown> } } };
          };
        };
      };
      // Баланс объявлен в `meta` документа: доменное поле, о котором клиент
      // иначе не узнал бы (ТЗ 3.5 такие поля допускает).
      expect(list.content['application/json'].schema.properties.meta.properties).toHaveProperty(
        'balance',
      );
    });
  });
});
