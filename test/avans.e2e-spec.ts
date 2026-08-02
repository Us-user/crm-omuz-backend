import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountType, AvansStatus, EmployeeStatus, Prisma } from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { AvansModule } from 'src/avans/avans.module';
import type {
  AvansCreateInput,
  AvansEmployee,
  AvansListParams,
  AvansRequestRow,
  AvansReviewInput,
  AvansReviewListParams,
  AvansReviewRow,
} from 'src/avans/avans.repository';
import { AvansRepository } from 'src/avans/avans.repository';
import { AvansSortField } from 'src/avans/dto';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, SortOrder, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { PhoneModule } from 'src/phone/phone.module';
import { RbacModule } from 'src/rbac/rbac.module';
import { RbacRepository } from 'src/rbac/rbac.repository';
import { buildOpenApiDocument } from 'src/swagger';

/** `{ data }` ответа с ожидаемым типом — тела supertest типизированы как `any`. */
const dataOf = <T>(response: { body: unknown }): T => (response.body as { data: T }).data;
const metaOf = (response: { body: unknown }): { total: number; page: number; limit: number } =>
  (response.body as { meta: { total: number; page: number; limit: number } }).meta;
const messageOf = (response: { body: unknown }): string =>
  (response.body as { error: { message: string } }).error.message;

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

interface StoredEmployee extends AvansEmployee {
  accountId: string | null;
}

/**
 * Заявки на аванс в памяти: сотрудники, их аккаунты и сами заявки.
 *
 * Одно хранилище на всё сразу не для удобства: правила модуля связывают их
 * между собой. Подача смотрит на статус сотрудника (`INACTIVE` не подаёт),
 * правило «одна нерассмотренная» ищет заявку того же сотрудника, а автор
 * заявки выводится из аккаунта в токене — то есть профили и заявки обязаны
 * жить в одном месте, иначе проверялось бы не то поведение, которое даёт БД.
 */
class InMemoryAvansStore {
  readonly employees = new Map<string, StoredEmployee>();
  readonly requests = new Map<string, AvansRequestRow>();

  addEmployee(overrides: Partial<StoredEmployee> = {}): StoredEmployee {
    const employee: StoredEmployee = {
      id: randomUUID(),
      firstName: 'Фаррух',
      lastName: 'Раҳимов',
      status: EmployeeStatus.ACTIVE,
      accountId: null,
      ...overrides,
    };
    this.employees.set(employee.id, employee);

    return employee;
  }

  addRequest(employeeId: string, overrides: Partial<AvansRequestRow> = {}): AvansRequestRow {
    const row: AvansRequestRow = {
      id: randomUUID(),
      employeeId,
      amount: new Prisma.Decimal('500.00'),
      reason: 'Оплата аренды жилья',
      month: new Date('2026-09-01T00:00:00.000Z'),
      status: AvansStatus.PENDING,
      reviewedAt: null,
      reviewComment: null,
      createdAt: new Date(Date.now() + this.requests.size),
      createdBy: null,
      reviewedBy: null,
      ...overrides,
    };
    this.requests.set(row.id, row);

    return row;
  }

  requestsOf(employeeId: string): AvansRequestRow[] {
    return [...this.requests.values()].filter((row) => row.employeeId === employeeId);
  }

  findMany(params: AvansListParams): Promise<{ rows: AvansRequestRow[]; total: number }> {
    const matched = this.requestsOf(params.employeeId)
      .filter((row) => params.status === undefined || row.status === params.status)
      .filter((row) => params.from === undefined || row.month.getTime() >= params.from.getTime())
      .filter((row) => params.to === undefined || row.month.getTime() <= params.to.getTime())
      .sort((a, b) => {
        const asc =
          params.sort === AvansSortField.Month
            ? a.month.getTime() - b.month.getTime()
            : params.sort === AvansSortField.Amount
              ? Number(a.amount) - Number(b.amount)
              : a.createdAt.getTime() - b.createdAt.getTime();

        return params.order === SortOrder.Asc ? asc : -asc;
      });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findByIdForEmployee(id: string, employeeId: string): Promise<AvansRequestRow | null> {
    const row = this.requests.get(id);

    return Promise.resolve(row && row.employeeId === employeeId ? row : null);
  }

  findPending(employeeId: string): Promise<AvansRequestRow | null> {
    const found = this.requestsOf(employeeId)
      .filter((row) => row.status === AvansStatus.PENDING)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return Promise.resolve(found[0] ?? null);
  }

  create(input: AvansCreateInput): Promise<AvansRequestRow> {
    const author = input.createdById === null ? null : this.employees.get(input.createdById);

    return Promise.resolve(
      this.addRequest(input.employeeId, {
        amount: new Prisma.Decimal(input.amount),
        reason: input.reason,
        month: input.month,
        createdBy:
          author === undefined || author === null
            ? null
            : { id: author.id, firstName: author.firstName, lastName: author.lastName },
      }),
    );
  }

  delete(id: string): Promise<void> {
    this.requests.delete(id);

    return Promise.resolve();
  }

  findEmployee(id: string): Promise<AvansEmployee | null> {
    const employee = this.employees.get(id);

    return Promise.resolve(
      employee
        ? {
            id: employee.id,
            firstName: employee.firstName,
            lastName: employee.lastName,
            status: employee.status,
          }
        : null,
    );
  }

  findEmployeeByAccount(accountId: string): Promise<{ id: string } | null> {
    const found = [...this.employees.values()].find((row) => row.accountId === accountId);

    return Promise.resolve(found ? { id: found.id } : null);
  }

  // ─────────────── Рассмотрение (ТЗ 5.16, бухгалтерия) ────────────────

  findManyForReview(
    params: AvansReviewListParams,
  ): Promise<{ rows: AvansReviewRow[]; total: number }> {
    const matched = [...this.requests.values()]
      .filter((row) => params.employeeId === undefined || row.employeeId === params.employeeId)
      .filter((row) => params.status === undefined || row.status === params.status)
      .filter((row) => params.from === undefined || row.month.getTime() >= params.from.getTime())
      .filter((row) => params.to === undefined || row.month.getTime() <= params.to.getTime())
      .filter((row) => {
        if (params.search === undefined) return true;
        const needle = params.search.toLowerCase();
        const employee = this.employees.get(row.employeeId);

        return (
          (employee?.firstName ?? '').toLowerCase().includes(needle) ||
          (employee?.lastName ?? '').toLowerCase().includes(needle) ||
          row.reason.toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => {
        const asc =
          params.sort === AvansSortField.Month
            ? a.month.getTime() - b.month.getTime()
            : params.sort === AvansSortField.Amount
              ? Number(a.amount) - Number(b.amount)
              : a.createdAt.getTime() - b.createdAt.getTime();

        return params.order === SortOrder.Asc ? asc : -asc;
      });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take).map((row) => this.reviewRow(row)),
      total: matched.length,
    });
  }

  findByIdForReview(id: string): Promise<AvansReviewRow | null> {
    const row = this.requests.get(id);

    return Promise.resolve(row === undefined ? null : this.reviewRow(row));
  }

  /** То же, что делает `review` в БД: три колонки решения пишутся вместе. */
  review(id: string, input: AvansReviewInput): Promise<AvansReviewRow> {
    const row = this.requests.get(id) as AvansRequestRow;
    const reviewed = input.status !== AvansStatus.PENDING;
    const reviewer =
      input.reviewedById === null ? undefined : this.employees.get(input.reviewedById);

    const updated: AvansRequestRow = {
      ...row,
      status: input.status,
      reviewedAt: reviewed ? new Date('2026-09-05T08:30:00.000Z') : null,
      reviewComment: reviewed ? input.comment : null,
      reviewedBy:
        reviewed && reviewer !== undefined
          ? { id: reviewer.id, firstName: reviewer.firstName, lastName: reviewer.lastName }
          : null,
    };
    this.requests.set(id, updated);

    return Promise.resolve(this.reviewRow(updated));
  }

  /** Строка очереди — та же заявка плюс сотрудник, которому аванс. */
  private reviewRow(row: AvansRequestRow): AvansReviewRow {
    const employee = this.employees.get(row.employeeId);

    return {
      ...row,
      employee: {
        id: row.employeeId,
        firstName: employee?.firstName ?? '—',
        lastName: employee?.lastName ?? '—',
        status: employee?.status ?? EmployeeStatus.ACTIVE,
      },
    };
  }
}

interface AvansBody {
  id: string;
  employeeId: string;
  amount: number;
  reason: string;
  month: string;
  status: AvansStatus;
  createdBy: { id: string; firstName: string; lastName: string } | null;
  review: { reviewedBy: unknown; reviewedAt: string; comment: string | null } | null;
}

const VIEWS = 'Permission.Avans.Views';
const CREATE = 'Permission.Avans.Create';
const APPROVE = 'Permission.Avans.Approve';
const ALL = [VIEWS, CREATE, APPROVE];

const REQUEST = { amount: 500, reason: 'Оплата аренды жилья', month: '2026-09' };

describe('Заявки на аванс (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryAvansStore;
  let rbac: InMemoryRbacRepository;
  let tokens: TokenService;

  beforeEach(async () => {
    store = new InMemoryAvansStore();
    rbac = new InMemoryRbacRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        PhoneModule,
        AuthModule,
        RbacModule,
        AvansModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
      ],
    })
      // AuthModule нужен целиком: он приносит глобальный `JwtAuthGuard`.
      .overrideProvider(AuthRepository)
      .useValue({})
      .overrideProvider(AvansRepository)
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

  /** Токен сотрудника с правами; `accountId` возвращается, чтобы связать его с профилем. */
  const accountWith = async (codes: string[]): Promise<{ token: string; accountId: string }> => {
    const accountId = randomUUID();
    rbac.grant(accountId, codes);
    const { accessToken } = await tokens.issuePair({
      sub: accountId,
      sid: randomUUID(),
      type: AccountType.EMPLOYEE,
    });

    return { token: accessToken, accountId };
  };

  const tokenWith = async (codes: string[]): Promise<string> => (await accountWith(codes)).token;

  const studentToken = async (): Promise<string> =>
    (await tokens.issuePair({ sub: randomUUID(), sid: randomUUID(), type: AccountType.STUDENT }))
      .accessToken;

  const server = () => request(app.getHttpServer());
  const get = (url: string, token: string) =>
    server().get(url).set('Authorization', `Bearer ${token}`);
  const post = (url: string, token: string, payload: object) =>
    server().post(url).set('Authorization', `Bearer ${token}`).send(payload);
  const del = (url: string, token: string) =>
    server().delete(url).set('Authorization', `Bearer ${token}`);

  // ───────────────────────────── Доступ ─────────────────────────────

  describe('Доступ', () => {
    it('401 без токена', async () => {
      const employee = store.addEmployee();

      await server().get(`/api/v1/employees/${employee.id}/avans`).expect(401);
      await server().post(`/api/v1/employees/${employee.id}/avans`).send(REQUEST).expect(401);
    });

    it('403 студенту: авансы сотрудников — не то, что видит студент', async () => {
      const employee = store.addEmployee();

      await get(`/api/v1/employees/${employee.id}/avans`, await studentToken()).expect(403);
    });

    it('403 сотруднику без прав', async () => {
      const employee = store.addEmployee();

      await get(`/api/v1/employees/${employee.id}/avans`, await tokenWith([])).expect(403);
    });

    it('право на просмотр не даёт подавать заявку', async () => {
      const employee = store.addEmployee();

      await post(
        `/api/v1/employees/${employee.id}/avans`,
        await tokenWith([VIEWS]),
        REQUEST,
      ).expect(403);
      expect(store.requests.size).toBe(0);
    });

    it('право на одобрение не заменяет право на подачу (одобрение — Фаза 9)', async () => {
      const employee = store.addEmployee();

      await post(
        `/api/v1/employees/${employee.id}/avans`,
        await tokenWith([VIEWS, APPROVE]),
        REQUEST,
      ).expect(403);
    });

    it('право на карточку сотрудника авансы не открывает', async () => {
      const employee = store.addEmployee();

      await get(
        `/api/v1/employees/${employee.id}/avans`,
        await tokenWith(['Permission.Employees.Views']),
      ).expect(403);
    });

    it('отзыв требует права подачи, а не просмотра', async () => {
      const employee = store.addEmployee();
      const avans = store.addRequest(employee.id);

      await del(
        `/api/v1/employees/${employee.id}/avans/${avans.id}`,
        await tokenWith([VIEWS]),
      ).expect(403);
      expect(store.requests.has(avans.id)).toBe(true);
    });
  });

  // ───────────────────────────── Подача ─────────────────────────────

  describe('Подача заявки (ТЗ 5.14)', () => {
    it('заводит заявку в статусе PENDING и отдаёт 201', async () => {
      const employee = store.addEmployee();

      const response = await post(
        `/api/v1/employees/${employee.id}/avans`,
        await tokenWith(ALL),
        REQUEST,
      ).expect(201);

      const avans = dataOf<AvansBody>(response);
      expect(avans).toMatchObject({
        employeeId: employee.id,
        amount: 500,
        reason: 'Оплата аренды жилья',
        month: '2026-09',
        status: AvansStatus.PENDING,
        review: null,
      });
      expect(typeof avans.amount).toBe('number');
    });

    it('подписывает заявку сотрудником из токена', async () => {
      const { token, accountId } = await accountWith(ALL);
      const author = store.addEmployee({ accountId, firstName: 'Нигина', lastName: 'Каримова' });
      const employee = store.addEmployee({ lastName: 'Сафаров' });

      const response = await post(`/api/v1/employees/${employee.id}/avans`, token, REQUEST).expect(
        201,
      );

      expect(dataOf<AvansBody>(response).createdBy).toEqual({
        id: author.id,
        firstName: 'Нигина',
        lastName: 'Каримова',
      });
    });

    it('аккаунт без профиля сотрудника заводит заявку без подписи', async () => {
      const employee = store.addEmployee();

      const response = await post(
        `/api/v1/employees/${employee.id}/avans`,
        await tokenWith(ALL),
        REQUEST,
      ).expect(201);

      expect(dataOf<AvansBody>(response).createdBy).toBeNull();
    });

    it('копейки не теряются: 1234.56 остаётся 1234.56', async () => {
      const employee = store.addEmployee();

      const response = await post(`/api/v1/employees/${employee.id}/avans`, await tokenWith(ALL), {
        ...REQUEST,
        amount: 1234.56,
      }).expect(201);

      expect(dataOf<AvansBody>(response).amount).toBe(1234.56);
    });

    it('409 на вторую нерассмотренную заявку — с суммой и месяцем первой, вторая не заведена', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();

      await post(`/api/v1/employees/${employee.id}/avans`, token, {
        ...REQUEST,
        amount: 300,
        month: '2026-08',
      }).expect(201);

      const response = await post(`/api/v1/employees/${employee.id}/avans`, token, REQUEST).expect(
        409,
      );

      expect(messageOf(response)).toContain('300');
      expect(messageOf(response)).toContain('2026-08');
      expect(store.requestsOf(employee.id)).toHaveLength(1);
    });

    it('отозвал первую — вторую подать можно', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();

      const first = dataOf<AvansBody>(
        await post(`/api/v1/employees/${employee.id}/avans`, token, REQUEST).expect(201),
      );
      await post(`/api/v1/employees/${employee.id}/avans`, token, REQUEST).expect(409);

      await del(`/api/v1/employees/${employee.id}/avans/${first.id}`, token).expect(200);
      await post(`/api/v1/employees/${employee.id}/avans`, token, REQUEST).expect(201);
    });

    it('рассмотренная заявка подаче следующей не мешает', async () => {
      const employee = store.addEmployee();
      store.addRequest(employee.id, {
        status: AvansStatus.APPROVED,
        reviewedAt: new Date('2026-09-05T08:30:00.000Z'),
      });

      await post(`/api/v1/employees/${employee.id}/avans`, await tokenWith(ALL), REQUEST).expect(
        201,
      );
      expect(store.requestsOf(employee.id)).toHaveLength(2);
    });

    it('заявка соседнего сотрудника подаче не мешает', async () => {
      const first = store.addEmployee();
      const second = store.addEmployee({ lastName: 'Сафаров' });
      store.addRequest(first.id);

      await post(`/api/v1/employees/${second.id}/avans`, await tokenWith(ALL), REQUEST).expect(201);
    });

    it('422 на выведенного из штата — заявка не заведена', async () => {
      const employee = store.addEmployee({ status: EmployeeStatus.INACTIVE });

      const response = await post(
        `/api/v1/employees/${employee.id}/avans`,
        await tokenWith(ALL),
        REQUEST,
      ).expect(422);

      expect(messageOf(response)).toContain('выведен из штата');
      expect(store.requests.size).toBe(0);
    });

    it('404 на неизвестного сотрудника', async () => {
      await post(`/api/v1/employees/${randomUUID()}/avans`, await tokenWith(ALL), REQUEST).expect(
        404,
      );
    });

    it.each([
      ['нулевую сумму', { ...REQUEST, amount: 0 }],
      ['отрицательную сумму', { ...REQUEST, amount: -100 }],
      ['сумму с тремя знаками', { ...REQUEST, amount: 500.555 }],
      ['сумму строкой', { ...REQUEST, amount: '500' }],
      ['причину в два символа', { ...REQUEST, reason: 'ок' }],
      ['месяц без нуля', { ...REQUEST, month: '2026-9' }],
      ['месяц с днём', { ...REQUEST, month: '2026-09-01' }],
      ['тринадцатый месяц', { ...REQUEST, month: '2026-13' }],
      ['лишнее поле', { ...REQUEST, status: AvansStatus.APPROVED }],
      ['без месяца', { amount: 500, reason: 'Оплата аренды жилья' }],
    ])('400 на %s', async (_case, payload) => {
      const employee = store.addEmployee();

      await post(`/api/v1/employees/${employee.id}/avans`, await tokenWith(ALL), payload).expect(
        400,
      );
      expect(store.requests.size).toBe(0);
    });

    it('400 на не-UUID в пути', async () => {
      await post('/api/v1/employees/не-uuid/avans', await tokenWith(ALL), REQUEST).expect(400);
    });
  });

  // ───────────────────────────── Список ─────────────────────────────

  describe('Список заявок', () => {
    it('отдаёт { data, meta } свежими сверху', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();
      store.addRequest(employee.id, {
        status: AvansStatus.DENIED,
        month: new Date('2026-07-01T00:00:00.000Z'),
        reviewedAt: new Date('2026-07-05T08:30:00.000Z'),
      });
      store.addRequest(employee.id, { month: new Date('2026-09-01T00:00:00.000Z') });

      const response = await get(`/api/v1/employees/${employee.id}/avans`, token).expect(200);

      const rows = dataOf<AvansBody[]>(response);
      expect(rows.map((row) => row.month)).toEqual(['2026-09', '2026-07']);
      expect(metaOf(response)).toMatchObject({ total: 2, page: 1, limit: 20 });
    });

    it('у рассмотренной заявки виден итог, у нерассмотренной — null', async () => {
      const employee = store.addEmployee();
      const reviewer = store.addEmployee({ firstName: 'Мижгона', lastName: 'Раҳимова' });
      store.addRequest(employee.id, {
        status: AvansStatus.APPROVED,
        reviewedAt: new Date('2026-09-05T08:30:00.000Z'),
        reviewComment: 'Одобрено в полном объёме',
        reviewedBy: { id: reviewer.id, firstName: 'Мижгона', lastName: 'Раҳимова' },
      });

      const response = await get(
        `/api/v1/employees/${employee.id}/avans`,
        await tokenWith(ALL),
      ).expect(200);

      expect(dataOf<AvansBody[]>(response)[0]?.review).toEqual({
        reviewedBy: { id: reviewer.id, firstName: 'Мижгона', lastName: 'Раҳимова' },
        reviewedAt: '2026-09-05T08:30:00.000Z',
        comment: 'Одобрено в полном объёме',
      });
    });

    it('фильтр по статусу разделяет очередь и решённое', async () => {
      const employee = store.addEmployee();
      store.addRequest(employee.id);
      store.addRequest(employee.id, {
        status: AvansStatus.APPROVED,
        reviewedAt: new Date('2026-09-05T08:30:00.000Z'),
      });

      const pending = await get(
        `/api/v1/employees/${employee.id}/avans?status=PENDING`,
        await tokenWith(ALL),
      ).expect(200);

      expect(dataOf<AvansBody[]>(pending)).toHaveLength(1);
      expect(dataOf<AvansBody[]>(pending)[0]?.status).toBe(AvansStatus.PENDING);
    });

    it('период по месяцу зарплаты включает границы', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();
      for (const month of ['2026-07-01', '2026-08-01', '2026-09-01']) {
        store.addRequest(employee.id, {
          status: AvansStatus.APPROVED,
          month: new Date(`${month}T00:00:00.000Z`),
          reviewedAt: new Date('2026-09-05T08:30:00.000Z'),
        });
      }

      const response = await get(
        `/api/v1/employees/${employee.id}/avans?from=2026-07&to=2026-08&order=asc&sort=month`,
        token,
      ).expect(200);

      expect(dataOf<AvansBody[]>(response).map((row) => row.month)).toEqual(['2026-07', '2026-08']);
    });

    it('сортировка по сумме', async () => {
      const employee = store.addEmployee();
      store.addRequest(employee.id, { amount: new Prisma.Decimal('900.00') });
      store.addRequest(employee.id, { amount: new Prisma.Decimal('100.00') });

      const response = await get(
        `/api/v1/employees/${employee.id}/avans?sort=amount&order=asc`,
        await tokenWith(ALL),
      ).expect(200);

      expect(dataOf<AvansBody[]>(response).map((row) => row.amount)).toEqual([100, 900]);
    });

    it('заявки соседнего сотрудника в список не попадают', async () => {
      const first = store.addEmployee();
      const second = store.addEmployee({ lastName: 'Сафаров' });
      store.addRequest(second.id);

      const response = await get(
        `/api/v1/employees/${first.id}/avans`,
        await tokenWith(ALL),
      ).expect(200);

      expect(dataOf<AvansBody[]>(response)).toHaveLength(0);
    });

    it('404 на неизвестного сотрудника, 400 на неизвестное поле сортировки', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();

      await get(`/api/v1/employees/${randomUUID()}/avans`, token).expect(404);
      await get(`/api/v1/employees/${employee.id}/avans?sort=reason`, token).expect(400);
      await get(`/api/v1/employees/${employee.id}/avans?from=2026-13`, token).expect(400);
    });
  });

  // ───────────────────────────── Отзыв ─────────────────────────────

  describe('Отзыв заявки', () => {
    it('отзывает нерассмотренную и называет сумму с месяцем', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();
      const avans = store.addRequest(employee.id);

      const response = await del(
        `/api/v1/employees/${employee.id}/avans/${avans.id}`,
        token,
      ).expect(200);

      expect(dataOf<{ amount: number; month: string }>(response)).toMatchObject({
        amount: 500,
        month: '2026-09',
      });
      expect(store.requests.has(avans.id)).toBe(false);
      await del(`/api/v1/employees/${employee.id}/avans/${avans.id}`, token).expect(404);
    });

    it.each([AvansStatus.APPROVED, AvansStatus.DENIED])(
      '422 на отзыв заявки в статусе %s — она осталась на месте',
      async (status) => {
        const employee = store.addEmployee();
        const avans = store.addRequest(employee.id, {
          status,
          reviewedAt: new Date('2026-09-05T08:30:00.000Z'),
        });

        const response = await del(
          `/api/v1/employees/${employee.id}/avans/${avans.id}`,
          await tokenWith(ALL),
        ).expect(422);

        expect(messageOf(response)).toContain('расчёт зарплаты');
        expect(store.requests.has(avans.id)).toBe(true);
      },
    );

    it('404 на заявку соседнего сотрудника — вложенность адреса это не защита сама по себе', async () => {
      const first = store.addEmployee();
      const second = store.addEmployee({ lastName: 'Сафаров' });
      const avans = store.addRequest(second.id);

      await del(`/api/v1/employees/${first.id}/avans/${avans.id}`, await tokenWith(ALL)).expect(
        404,
      );
      expect(store.requests.has(avans.id)).toBe(true);
    });

    it('404 на неизвестного сотрудника, 400 на не-UUID заявки', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();

      await del(`/api/v1/employees/${randomUUID()}/avans/${randomUUID()}`, token).expect(404);
      await del(`/api/v1/employees/${employee.id}/avans/не-uuid`, token).expect(400);
    });
  });

  // ──────────────── Рассмотрение (ТЗ 5.16, бухгалтерия) ─────────────────

  describe('Рассмотрение заявок (ТЗ 5.16)', () => {
    /** Заявка, поданная настоящим маршрутом, — очередь читает её же. */
    const submit = async (employeeId: string): Promise<AvansBody> =>
      dataOf<AvansBody>(
        await post(`/api/v1/employees/${employeeId}/avans`, await tokenWith(ALL), REQUEST).expect(
          201,
        ),
      );

    it('очередь показывает заявки всего центра с сотрудником в строке', async () => {
      const first = store.addEmployee();
      const second = store.addEmployee({ lastName: 'Сафаров' });
      await submit(first.id);
      await submit(second.id);

      const rows = dataOf<(AvansBody & { employee: { lastName: string } })[]>(
        await get('/api/v1/accounting/avans', await tokenWith([VIEWS])).expect(200),
      );

      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.employee.lastName).sort()).toEqual(['Раҳимов', 'Сафаров']);
    });

    it('одобрение подписывается рассмотревшим из токена и меняет статус', async () => {
      const employee = store.addEmployee();
      const avans = await submit(employee.id);
      const reviewer = store.addEmployee({ firstName: 'Аниса', lastName: 'Р.' });
      const account = await accountWith(ALL);
      reviewer.accountId = account.accountId;

      const body = dataOf<AvansBody>(
        await post(`/api/v1/accounting/avans/${avans.id}/approve`, account.token, {
          comment: 'Одобрено в полном объёме',
        }).expect(200),
      );

      expect(body.status).toBe(AvansStatus.APPROVED);
      expect(body.review).toMatchObject({
        comment: 'Одобрено в полном объёме',
        reviewedBy: { id: reviewer.id, lastName: 'Р.' },
      });
    });

    it('одобрение без комментария проходит, отказ без причины — 400', async () => {
      const employee = store.addEmployee();
      const token = await tokenWith(ALL);

      const first = await submit(employee.id);
      await post(`/api/v1/accounting/avans/${first.id}/approve`, token, {}).expect(200);

      const second = await submit(employee.id);
      await post(`/api/v1/accounting/avans/${second.id}/deny`, token, {}).expect(400);
      await post(`/api/v1/accounting/avans/${second.id}/deny`, token, { comment: 'Ок' }).expect(
        400,
      );

      expect(store.requests.get(second.id)?.status).toBe(AvansStatus.PENDING);
    });

    it('отказ пишет причину — человек должен узнать, почему отказали', async () => {
      const employee = store.addEmployee();
      const avans = await submit(employee.id);

      const body = dataOf<AvansBody>(
        await post(`/api/v1/accounting/avans/${avans.id}/deny`, await tokenWith(ALL), {
          comment: 'Превышает половину оклада',
        }).expect(200),
      );

      expect(body.status).toBe(AvansStatus.DENIED);
      expect(body.review?.comment).toBe('Превышает половину оклада');
    });

    it('409 на повторное рассмотрение — решение не переписывается вторым', async () => {
      const employee = store.addEmployee();
      const avans = await submit(employee.id);
      const token = await tokenWith(ALL);

      await post(`/api/v1/accounting/avans/${avans.id}/approve`, token, {}).expect(200);
      await post(`/api/v1/accounting/avans/${avans.id}/approve`, token, {}).expect(409);
      await post(`/api/v1/accounting/avans/${avans.id}/deny`, token, {
        comment: 'Передумали',
      }).expect(409);

      expect(store.requests.get(avans.id)?.status).toBe(AvansStatus.APPROVED);
    });

    it('422 на одобрение выведенному из штата, отказать при этом можно', async () => {
      // Одобренная заявка становится `Prepaid` месяца (ТЗ 5.16) — то есть
      // выплатой тому, кого в штате нет.
      const employee = store.addEmployee();
      const avans = await submit(employee.id);
      const token = await tokenWith(ALL);
      employee.status = EmployeeStatus.INACTIVE;

      const response = await post(`/api/v1/accounting/avans/${avans.id}/approve`, token, {}).expect(
        422,
      );
      expect(messageOf(response)).toContain('выведен');
      expect(store.requests.get(avans.id)?.status).toBe(AvansStatus.PENDING);

      await post(`/api/v1/accounting/avans/${avans.id}/deny`, token, { comment: 'Уволен' }).expect(
        200,
      );
    });

    it('рассмотренная заявка освобождает подачу следующей', async () => {
      // Правило «одна нерассмотренная» (0022) смотрит только на `PENDING`.
      const employee = store.addEmployee();
      const token = await tokenWith(ALL);
      const first = await submit(employee.id);

      await post(`/api/v1/employees/${employee.id}/avans`, token, REQUEST).expect(409);
      await post(`/api/v1/accounting/avans/${first.id}/deny`, token, { comment: 'Много' }).expect(
        200,
      );
      await post(`/api/v1/employees/${employee.id}/avans`, token, REQUEST).expect(201);
    });

    it('снятие рассмотрения возвращает заявку в работу и гасит колонки решения', async () => {
      const employee = store.addEmployee();
      const avans = await submit(employee.id);
      const token = await tokenWith(ALL);

      await post(`/api/v1/accounting/avans/${avans.id}/approve`, token, {}).expect(200);

      const body = dataOf<AvansBody>(
        await del(`/api/v1/accounting/avans/${avans.id}/review`, token)
          .send({ reason: 'Одобрено по ошибке, не тот сотрудник' })
          .expect(200),
      );

      expect(body.status).toBe(AvansStatus.PENDING);
      expect(body.review).toBeNull();
      // Вернувшаяся в работу заявка снова отзывается — рассмотренная не отзывалась бы.
      await del(`/api/v1/employees/${employee.id}/avans/${avans.id}`, token).expect(200);
    });

    it('409 на снятие, если у сотрудника уже есть другая нерассмотренная', async () => {
      // Иначе у человека оказалось бы две `PENDING` — состояние, которое
      // подача не допускает.
      const employee = store.addEmployee();
      const token = await tokenWith(ALL);
      const first = await submit(employee.id);

      await post(`/api/v1/accounting/avans/${first.id}/deny`, token, { comment: 'Много' }).expect(
        200,
      );
      await post(`/api/v1/employees/${employee.id}/avans`, token, REQUEST).expect(201);

      await del(`/api/v1/accounting/avans/${first.id}/review`, token)
        .send({ reason: 'Отказ был ошибочным' })
        .expect(409);

      expect(store.requests.get(first.id)?.status).toBe(AvansStatus.DENIED);
    });

    it('422 на снятие с нерассмотренной заявки, 400 без причины', async () => {
      const employee = store.addEmployee();
      const avans = await submit(employee.id);
      const token = await tokenWith(ALL);

      await del(`/api/v1/accounting/avans/${avans.id}/review`, token)
        .send({ reason: 'Просто так' })
        .expect(422);

      await post(`/api/v1/accounting/avans/${avans.id}/approve`, token, {}).expect(200);
      await del(`/api/v1/accounting/avans/${avans.id}/review`, token).send({}).expect(400);
    });

    it('фильтры очереди: статус, сотрудник, период и поиск по фамилии', async () => {
      const first = store.addEmployee();
      const second = store.addEmployee({ lastName: 'Сафаров' });
      const token = await tokenWith(ALL);
      const approved = await submit(first.id);
      await submit(second.id);

      await post(`/api/v1/accounting/avans/${approved.id}/approve`, token, {}).expect(200);

      const pending = dataOf<AvansBody[]>(
        await get('/api/v1/accounting/avans?status=PENDING', token).expect(200),
      );
      expect(pending).toHaveLength(1);
      expect(pending[0].employeeId).toBe(second.id);

      const mine = dataOf<AvansBody[]>(
        await get(`/api/v1/accounting/avans?employeeId=${first.id}`, token).expect(200),
      );
      expect(mine).toHaveLength(1);

      const found = dataOf<AvansBody[]>(
        await get('/api/v1/accounting/avans?search=Сафаров', token).expect(200),
      );
      expect(found).toHaveLength(1);
      expect(found[0].employeeId).toBe(second.id);

      const inPeriod = await get('/api/v1/accounting/avans?from=2026-09&to=2026-09', token).expect(
        200,
      );
      expect(metaOf(inPeriod).total).toBe(2);

      const outside = await get('/api/v1/accounting/avans?from=2026-10', token).expect(200);
      expect(metaOf(outside).total).toBe(0);
    });

    it('404 на неизвестную заявку, 400 на не-UUID и на негодный месяц', async () => {
      const token = await tokenWith(ALL);

      await get(`/api/v1/accounting/avans/${randomUUID()}`, token).expect(404);
      await post(`/api/v1/accounting/avans/${randomUUID()}/approve`, token, {}).expect(404);
      await get('/api/v1/accounting/avans/не-uuid', token).expect(400);
      await get('/api/v1/accounting/avans?from=2026-13', token).expect(400);
    });

    it('право на просмотр не даёт рассматривать, право на подачу — тоже', async () => {
      const employee = store.addEmployee();
      const avans = await submit(employee.id);

      await get('/api/v1/accounting/avans', await tokenWith([VIEWS])).expect(200);
      await post(
        `/api/v1/accounting/avans/${avans.id}/approve`,
        await tokenWith([VIEWS]),
        {},
      ).expect(403);
      await post(
        `/api/v1/accounting/avans/${avans.id}/approve`,
        await tokenWith([CREATE]),
        {},
      ).expect(403);
      // И наоборот: право на рассмотрение не заменяет право на просмотр очереди.
      await get('/api/v1/accounting/avans', await tokenWith([APPROVE])).expect(403);
    });

    it('401 без токена, 403 студенту и сотруднику без прав', async () => {
      await server().get('/api/v1/accounting/avans').expect(401);
      await get('/api/v1/accounting/avans', await studentToken()).expect(403);
      await get('/api/v1/accounting/avans', await tokenWith([])).expect(403);
    });
  });

  describe('OpenAPI', () => {
    it('два пути описаны, подача отвечает 201, а правки заявки нет', () => {
      const document = buildOpenApiDocument(app);

      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/employees/{employeeId}/avans',
          '/api/v1/employees/{employeeId}/avans/{avansId}',
        ]),
      );

      const list = document.paths['/api/v1/employees/{employeeId}/avans'];
      expect(list?.get?.responses['200']).toBeDefined();
      expect(list?.post?.responses['201']).toBeDefined();
      expect(list?.post?.responses['200']).toBeUndefined();
      // Заявка не правится: сумму и причину меняют отзывом и новой подачей.
      expect(list?.put).toBeUndefined();

      const single = document.paths['/api/v1/employees/{employeeId}/avans/{avansId}'];
      expect(single?.delete?.responses['200']).toBeDefined();
      expect(single?.put).toBeUndefined();
    });

    it('пути рассмотрения описаны, решения отвечают 200 и не 201', () => {
      const document = buildOpenApiDocument(app);

      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/accounting/avans',
          '/api/v1/accounting/avans/{id}',
          '/api/v1/accounting/avans/{id}/approve',
          '/api/v1/accounting/avans/{id}/deny',
          '/api/v1/accounting/avans/{id}/review',
        ]),
      );

      // `POST /accounting/avans` из перечня ТЗ здесь не заводится: подача уже
      // есть по адресу сотрудника, и третий способ завести заявку был бы
      // третьим набором правил о том же.
      expect(Object.keys(document.paths['/api/v1/accounting/avans'] ?? {})).toEqual(['get']);

      const approve = document.paths['/api/v1/accounting/avans/{id}/approve'];
      expect(approve?.post?.responses['200']).toBeDefined();
      expect(approve?.post?.responses['201']).toBeUndefined();

      const review = document.paths['/api/v1/accounting/avans/{id}/review'];
      expect(review?.delete?.responses['200']).toBeDefined();
    });
  });
});
