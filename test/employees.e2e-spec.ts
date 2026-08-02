import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  AccountStatus,
  AccountType,
  EmployeeStatus,
  Gender,
  GroupMentorRole,
} from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, SortOrder, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { EmployeeSortField } from 'src/employees/dto';
import { EmployeesModule } from 'src/employees/employees.module';
import type {
  EmployeeDeletionCheck,
  EmployeeListParams,
  EmployeeRow,
  EmployeeUpdateInput,
  EmployeeWriteInput,
  PositionRow,
} from 'src/employees/employees.repository';
import { EmployeesRepository } from 'src/employees/employees.repository';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { PhoneModule } from 'src/phone/phone.module';
import { RbacModule } from 'src/rbac/rbac.module';
import { RbacRepository } from 'src/rbac/rbac.repository';
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

interface StoredGroup {
  id: string;
  name: string;
  courseId: string;
  courseTitle: string;
}

/** Счётчики того, что держит профиль при удалении (ТЗ 5.5, 5.8, 5.3, 5.9). */
type WorkTrace = EmployeeDeletionCheck['_count'];

const NO_TRACE: WorkTrace = {
  mentorGroups: 0,
  mentorSlots: 0,
  submittedWeeks: 0,
  authoredFeedback: 0,
  awardedCoins: 0,
  taughtDays: 0,
  salaries: 0,
};

/**
 * Сотрудники в памяти вместе с филиалами, позициями, аккаунтами и группами.
 *
 * Одно хранилище на всё сразу не для удобства: правила модуля связывают их между
 * собой. Замена позиций смотрит на справочник, правило «последний `Director`»
 * считает **действующих** держателей позиции по всем сотрудникам, а перевод
 * в `INACTIVE` трогает аккаунт и сессии. Несогласованные заглушки проверяли бы
 * не то поведение, которое даёт БД.
 */
class InMemoryEmployeesStore {
  readonly employees = new Map<string, EmployeeRow>();
  readonly branches = new Map<string, { id: string; name: string }>();
  readonly positions = new Map<string, PositionRow>();
  readonly traces = new Map<string, WorkTrace>();
  /** Аккаунты сотрудников: на них проверяется, что `INACTIVE` закрывает вход. */
  readonly accounts = new Map<string, { id: string; status: AccountStatus }>();
  /** Живые сессии аккаунта — их гашение и есть «выгнать уволенного отовсюду». */
  readonly liveSessions = new Map<string, number>();

  addBranch(name = 'Sadbarg'): { id: string; name: string } {
    const branch = { id: randomUUID(), name };
    this.branches.set(branch.id, branch);

    return branch;
  }

  addPosition(name: string, isSystem = false): PositionRow {
    const position = { id: randomUUID(), name, isSystem };
    this.positions.set(position.id, position);

    return position;
  }

  addEmployee(
    overrides: Partial<EmployeeRow> = {},
    positions: readonly PositionRow[] = [],
  ): EmployeeRow {
    const employee: EmployeeRow = {
      id: randomUUID(),
      firstName: 'Фаррух',
      lastName: 'Раҳимов',
      middleName: null,
      phone: `+9929012345${String(this.employees.size).padStart(2, '0')}`,
      birthDate: null,
      gender: null,
      address: null,
      email: null,
      telegram: null,
      photoUrl: null,
      experience: null,
      description: null,
      status: EmployeeStatus.ACTIVE,
      hiredAt: null,
      formerStudentId: null,
      createdAt: new Date(Date.now() + this.employees.size),
      branch: null,
      account: null,
      positions: positions.map((position) => ({ position })),
      mentorGroups: [],
      ...overrides,
    };
    this.employees.set(employee.id, employee);

    return employee;
  }

  /** Логин сотрудника — вместе с живыми сессиями, которые увольнение обязано погасить. */
  addAccount(employee: EmployeeRow, sessions = 2): { id: string; status: AccountStatus } {
    const account = { id: randomUUID(), status: AccountStatus.ACTIVE };
    this.accounts.set(account.id, account);
    this.liveSessions.set(account.id, sessions);
    this.employees.set(employee.id, {
      ...employee,
      account: {
        id: account.id,
        phone: employee.phone,
        email: `${account.id}@omuz.tj`,
        status: account.status,
      },
    });

    return account;
  }

  addMentorGroup(employee: EmployeeRow, group: StoredGroup, role: GroupMentorRole): void {
    const current = this.employees.get(employee.id);
    if (!current) return;

    this.employees.set(employee.id, {
      ...current,
      mentorGroups: [
        ...current.mentorGroups,
        {
          role,
          group: {
            id: group.id,
            name: group.name,
            courseId: group.courseId,
            course: { title: group.courseTitle },
          },
        },
      ],
    });
  }

  setTrace(employeeId: string, trace: Partial<WorkTrace>): void {
    this.traces.set(employeeId, { ...NO_TRACE, ...trace });
  }

  // ─── EmployeesRepository ───

  findMany(params: EmployeeListParams): Promise<{ rows: EmployeeRow[]; total: number }> {
    const search = params.search?.toLowerCase();

    const matched = [...this.employees.values()]
      .filter((row) => params.status === undefined || row.status === params.status)
      .filter((row) => params.branchId === undefined || row.branch?.id === params.branchId)
      .filter(
        (row) =>
          params.positionId === undefined ||
          row.positions.some(({ position }) => position.id === params.positionId),
      )
      .filter(
        (row) => params.hasAccount === undefined || (row.account !== null) === params.hasAccount,
      )
      .filter(
        (row) =>
          search === undefined ||
          row.firstName.toLowerCase().includes(search) ||
          row.lastName.toLowerCase().includes(search) ||
          (row.middleName?.toLowerCase().includes(search) ?? false) ||
          row.phone.includes(search) ||
          (row.email?.toLowerCase().includes(search) ?? false),
      )
      .sort((a, b) => {
        const asc =
          params.sort === EmployeeSortField.CreatedAt
            ? a.createdAt.getTime() - b.createdAt.getTime()
            : `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`);

        return params.order === SortOrder.Asc ? asc : -asc;
      });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findById(id: string): Promise<EmployeeRow | null> {
    return Promise.resolve(this.employees.get(id) ?? null);
  }

  findByPhone(phone: string): Promise<{ id: string; firstName: string; lastName: string } | null> {
    const found = [...this.employees.values()].find((row) => row.phone === phone);

    return Promise.resolve(
      found ? { id: found.id, firstName: found.firstName, lastName: found.lastName } : null,
    );
  }

  findBranch(id: string): Promise<{ id: string } | null> {
    const branch = this.branches.get(id);

    return Promise.resolve(branch ? { id: branch.id } : null);
  }

  findPositionsByIds(ids: readonly string[]): Promise<PositionRow[]> {
    return Promise.resolve(
      ids.flatMap((id) => (this.positions.has(id) ? [this.positions.get(id)!] : [])),
    );
  }

  /** Уволенный руководитель в счёт не идёт: вход ему закрыт, систему он не разблокирует. */
  countPositionHolders(positionId: string, exceptEmployeeId?: string): Promise<number> {
    return Promise.resolve(
      [...this.employees.values()].filter(
        (row) =>
          row.id !== exceptEmployeeId &&
          row.status === EmployeeStatus.ACTIVE &&
          row.positions.some(({ position }) => position.id === positionId),
      ).length,
    );
  }

  findForDeletion(id: string): Promise<EmployeeDeletionCheck | null> {
    const row = this.employees.get(id);
    if (!row) return Promise.resolve(null);

    return Promise.resolve({
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      accountId: row.account?.id ?? null,
      status: row.status,
      positions: row.positions,
      _count: this.traces.get(id) ?? NO_TRACE,
    });
  }

  create(input: EmployeeWriteInput, positionIds?: readonly string[]): Promise<EmployeeRow> {
    const branch = input.branchId === null ? null : (this.branches.get(input.branchId) ?? null);

    return Promise.resolve(
      this.addEmployee(
        {
          ...input,
          status: input.status ?? EmployeeStatus.ACTIVE,
          branch,
          formerStudentId: null,
          account: null,
        },
        (positionIds ?? []).flatMap((id) => {
          const position = this.positions.get(id);

          return position ? [position] : [];
        }),
      ),
    );
  }

  update(
    id: string,
    input: EmployeeUpdateInput,
    positionIds: readonly string[] | undefined,
    accountStatus: AccountStatus | undefined,
  ): Promise<{ employee: EmployeeRow; revokedSessions: number }> {
    const current = this.employees.get(id)!;
    // `undefined` Prisma пропускает — колонка остаётся прежней.
    const written = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as Partial<EmployeeRow>;

    const branch =
      input.branchId === undefined
        ? current.branch
        : input.branchId === null
          ? null
          : (this.branches.get(input.branchId) ?? null);

    let revokedSessions = 0;
    let account = current.account;

    if (accountStatus !== undefined && account !== null) {
      this.accounts.set(account.id, { id: account.id, status: accountStatus });
      account = { ...account, status: accountStatus };

      if (accountStatus === AccountStatus.BLOCKED) {
        revokedSessions = this.liveSessions.get(account.id) ?? 0;
        this.liveSessions.set(account.id, 0);
      }
    }

    const employee: EmployeeRow = {
      ...current,
      ...written,
      branch,
      account,
      positions:
        positionIds === undefined
          ? current.positions
          : positionIds.flatMap((positionId) => {
              const position = this.positions.get(positionId);

              return position ? [{ position }] : [];
            }),
    };
    this.employees.set(id, employee);

    return Promise.resolve({ employee, revokedSessions });
  }

  delete(id: string, accountId: string | null): Promise<void> {
    this.employees.delete(id);
    if (accountId !== null) this.accounts.delete(accountId);

    return Promise.resolve();
  }
}

interface EmployeeBody {
  id: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
  phone: string;
  birthDate: string | null;
  hiredAt: string | null;
  experience: string | null;
  branch: { id: string; name: string } | null;
  status: EmployeeStatus;
  account: { id: string; status: AccountStatus } | null;
  positions: { id: string; name: string; isSystem: boolean }[];
  groups: { id: string; name: string; courseTitle: string; role: GroupMentorRole }[];
}

interface DeletedBody {
  id: string;
  fullName: string;
  accountDeleted: boolean;
}

const VIEWS = 'Permission.Employees.Views';
const CREATE = 'Permission.Employees.Create';
const UPDATE = 'Permission.Employees.Update';
const DELETE = 'Permission.Employees.Delete';
const MANAGE_ROLES = 'Permission.Administration.ManageUserRoles';
const ALL = [VIEWS, CREATE, UPDATE, DELETE, MANAGE_ROLES];

describe('Сотрудники (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryEmployeesStore;
  let rbac: InMemoryRbacRepository;
  let tokens: TokenService;

  beforeEach(async () => {
    store = new InMemoryEmployeesStore();
    rbac = new InMemoryRbacRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        PhoneModule,
        AuthModule,
        RbacModule,
        EmployeesModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
      ],
    })
      // AuthModule нужен целиком: он приносит глобальный `JwtAuthGuard`.
      .overrideProvider(AuthRepository)
      .useValue({})
      .overrideProvider(EmployeesRepository)
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

  const tokenWith = async (codes: string[]): Promise<string> => {
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

  const server = () => request(app.getHttpServer());
  const get = (url: string, token: string) =>
    server().get(url).set('Authorization', `Bearer ${token}`);
  const post = (url: string, token: string, payload: object) =>
    server().post(url).set('Authorization', `Bearer ${token}`).send(payload);
  const put = (url: string, token: string, payload: object) =>
    server().put(url).set('Authorization', `Bearer ${token}`).send(payload);
  const del = (url: string, token: string) =>
    server().delete(url).set('Authorization', `Bearer ${token}`);

  const body = { firstName: 'Фаррух', lastName: 'Раҳимов', phone: '+992 90 111-22-33' };

  describe('Доступ (ТЗ 3.2, 3.8)', () => {
    it('401 без токена', async () => {
      await server().get('/api/v1/employees').expect(401);
    });

    it('403 студенту: персонал центра — не то, что он видит', async () => {
      await get('/api/v1/employees', await studentToken()).expect(403);
    });

    it('403 сотруднику без прав', async () => {
      await get('/api/v1/employees', await tokenWith([])).expect(403);
    });

    it('право на просмотр не даёт создавать, а на создание — удалять', async () => {
      await post('/api/v1/employees', await tokenWith([VIEWS]), body).expect(403);

      const created = dataOf<EmployeeBody>(
        await post('/api/v1/employees', await tokenWith([CREATE]), body).expect(201),
      );

      await del(`/api/v1/employees/${created.id}`, await tokenWith([CREATE])).expect(403);
    });

    it('право на студентов карточку сотрудника не открывает', async () => {
      await get('/api/v1/employees', await tokenWith(['Permission.Students.Views'])).expect(403);
    });
  });

  describe('Создание (ТЗ 5.14)', () => {
    it('заводит профиль со всеми полями формы, телефон приводится к E.164', async () => {
      const branch = store.addBranch();
      const token = await tokenWith(ALL);

      const created = dataOf<EmployeeBody>(
        await post('/api/v1/employees', token, {
          ...body,
          middleName: 'Саидович',
          birthDate: '1994-03-12',
          gender: Gender.MALE,
          address: 'ул. Рудаки, 105',
          email: 'Farrukh@Omuz.TJ',
          telegram: '@farrukh',
          experience: '5 лет разработки',
          description: 'Ведёт Frontend',
          branchId: branch.id,
          hiredAt: '2026-01-15',
        }).expect(201),
      );

      expect(created).toMatchObject({
        firstName: 'Фаррух',
        middleName: 'Саидович',
        phone: '+992901112233',
        birthDate: '1994-03-12',
        hiredAt: '2026-01-15',
        experience: '5 лет разработки',
        branch: { id: branch.id, name: 'Sadbarg' },
        status: EmployeeStatus.ACTIVE,
        account: null,
        positions: [],
      });
    });

    it('email приводится к нижнему регистру', async () => {
      const created = dataOf<EmployeeBody & { email: string }>(
        await post('/api/v1/employees', await tokenWith(ALL), {
          ...body,
          email: 'Farrukh@Omuz.TJ',
        }).expect(201),
      );

      expect(created.email).toBe('farrukh@omuz.tj');
    });

    it('409 на занятый телефон с именем владельца — сотрудник не создан', async () => {
      const token = await tokenWith(ALL);
      store.addEmployee({ phone: '+992901112233', firstName: 'Нигина', lastName: 'Каримова' });

      const response = await post('/api/v1/employees', token, body).expect(409);

      expect(JSON.stringify(response.body)).toContain('Каримова Нигина');
      expect(store.employees.size).toBe(1);
    });

    it('конфликт ловится и на номере в другом формате', async () => {
      const token = await tokenWith(ALL);
      store.addEmployee({ phone: '+992901112233' });

      await post('/api/v1/employees', token, { ...body, phone: '901112233' }).expect(409);
    });

    it('422 на несуществующий филиал — сотрудник не создан', async () => {
      const token = await tokenWith(ALL);

      await post('/api/v1/employees', token, { ...body, branchId: randomUUID() }).expect(422);
      expect(store.employees.size).toBe(0);
    });

    it('400 на неразобранный телефон, 30 февраля и лишнее поле', async () => {
      const token = await tokenWith(ALL);

      await post('/api/v1/employees', token, { ...body, phone: 'не телефон' }).expect(400);
      await post('/api/v1/employees', token, { ...body, birthDate: '1994-02-30' }).expect(400);
      await post('/api/v1/employees', token, { ...body, salary: 5000 }).expect(400);
    });
  });

  describe('Позиции в форме требуют права на роли (решение этой сессии)', () => {
    it('403 с одним лишь Employees.Create — сотрудник не создан', async () => {
      const mentor = store.addPosition('Mentor');

      await post('/api/v1/employees', await tokenWith([CREATE, VIEWS]), {
        ...body,
        positionIds: [mentor.id],
      }).expect(403);
      expect(store.employees.size).toBe(0);
    });

    it('с правом на роли позиции назначаются той же формой', async () => {
      const mentor = store.addPosition('Mentor');

      const created = dataOf<EmployeeBody>(
        await post('/api/v1/employees', await tokenWith(ALL), {
          ...body,
          positionIds: [mentor.id],
        }).expect(201),
      );

      expect(created.positions).toEqual([{ id: mentor.id, name: 'Mentor', isSystem: false }]);
    });

    it('403 при правке без права на роли — карточка не изменена', async () => {
      const mentor = store.addPosition('Mentor');
      const employee = store.addEmployee({}, [mentor]);

      await put(`/api/v1/employees/${employee.id}`, await tokenWith([UPDATE, VIEWS]), {
        positionIds: [],
      }).expect(403);
      expect(store.employees.get(employee.id)?.positions).toHaveLength(1);
    });

    it('правка карточки без позиций права на роли не требует', async () => {
      const employee = store.addEmployee();

      const updated = dataOf<EmployeeBody>(
        await put(`/api/v1/employees/${employee.id}`, await tokenWith([UPDATE, VIEWS]), {
          telegram: '@new',
        }).expect(200),
      );

      expect(updated).toMatchObject({ telegram: '@new' });
    });

    it('набор заменяется целиком, а пустой массив снимает все позиции', async () => {
      const mentor = store.addPosition('Mentor');
      const manager = store.addPosition('Manager');
      const employee = store.addEmployee({}, [mentor]);
      const token = await tokenWith(ALL);

      const replaced = dataOf<EmployeeBody>(
        await put(`/api/v1/employees/${employee.id}`, token, {
          positionIds: [manager.id],
        }).expect(200),
      );
      expect(replaced.positions.map(({ name }) => name)).toEqual(['Manager']);

      const cleared = dataOf<EmployeeBody>(
        await put(`/api/v1/employees/${employee.id}`, token, { positionIds: [] }).expect(200),
      );
      expect(cleared.positions).toEqual([]);
    });

    it('422 на несуществующую позицию — набор не изменён', async () => {
      const mentor = store.addPosition('Mentor');
      const employee = store.addEmployee({}, [mentor]);
      const missing = randomUUID();

      const response = await put(`/api/v1/employees/${employee.id}`, await tokenWith(ALL), {
        positionIds: [mentor.id, missing],
      }).expect(422);

      expect(JSON.stringify(response.body)).toContain(missing);
      expect(store.employees.get(employee.id)?.positions).toHaveLength(1);
    });

    it('400 на повтор в мультивыборе и на не-UUID', async () => {
      const mentor = store.addPosition('Mentor');
      const token = await tokenWith(ALL);

      await post('/api/v1/employees', token, {
        ...body,
        positionIds: [mentor.id, mentor.id],
      }).expect(400);
      await post('/api/v1/employees', token, { ...body, positionIds: ['не-uuid'] }).expect(400);
    });
  });

  describe('INACTIVE закрывает вход (решение этой сессии)', () => {
    it('перевод в INACTIVE блокирует аккаунт и гасит сессии', async () => {
      const employee = store.addEmployee();
      const account = store.addAccount(employee, 2);

      const updated = dataOf<EmployeeBody>(
        await put(`/api/v1/employees/${employee.id}`, await tokenWith(ALL), {
          status: EmployeeStatus.INACTIVE,
        }).expect(200),
      );

      expect(updated.status).toBe(EmployeeStatus.INACTIVE);
      expect(updated.account?.status).toBe(AccountStatus.BLOCKED);
      expect(store.accounts.get(account.id)?.status).toBe(AccountStatus.BLOCKED);
      expect(store.liveSessions.get(account.id)).toBe(0);
    });

    it('возврат в ACTIVE открывает вход обратно', async () => {
      const employee = store.addEmployee({ status: EmployeeStatus.INACTIVE });
      const account = store.addAccount(employee, 0);
      store.accounts.set(account.id, { id: account.id, status: AccountStatus.BLOCKED });
      const token = await tokenWith(ALL);

      const updated = dataOf<EmployeeBody>(
        await put(`/api/v1/employees/${employee.id}`, token, {
          status: EmployeeStatus.ACTIVE,
        }).expect(200),
      );

      expect(updated.account?.status).toBe(AccountStatus.ACTIVE);
      expect(store.accounts.get(account.id)?.status).toBe(AccountStatus.ACTIVE);
    });

    it('сохранение карточки без смены статуса сессии не гасит', async () => {
      const employee = store.addEmployee();
      const account = store.addAccount(employee, 2);

      await put(`/api/v1/employees/${employee.id}`, await tokenWith(ALL), {
        status: EmployeeStatus.ACTIVE,
        telegram: '@same',
      }).expect(200);

      expect(store.liveSessions.get(account.id)).toBe(2);
    });

    it('сотрудник без логина увольняется без ошибки', async () => {
      const employee = store.addEmployee();

      const updated = dataOf<EmployeeBody>(
        await put(`/api/v1/employees/${employee.id}`, await tokenWith(ALL), {
          status: EmployeeStatus.INACTIVE,
        }).expect(200),
      );

      expect(updated).toMatchObject({ status: EmployeeStatus.INACTIVE, account: null });
    });
  });

  describe('Последний действующий Director (ТЗ 3.2, 5.16)', () => {
    it('422 на снятие позиции, увольнение и удаление — все три пути закрыты', async () => {
      const director = store.addPosition('Director', true);
      const mentor = store.addPosition('Mentor');
      const boss = store.addEmployee({}, [director]);
      const token = await tokenWith(ALL);

      await put(`/api/v1/employees/${boss.id}`, token, { positionIds: [mentor.id] }).expect(422);
      await put(`/api/v1/employees/${boss.id}`, token, {
        status: EmployeeStatus.INACTIVE,
      }).expect(422);
      await del(`/api/v1/employees/${boss.id}`, token).expect(422);

      expect(store.employees.get(boss.id)?.positions).toHaveLength(1);
    });

    it('при втором руководителе все три операции проходят', async () => {
      const director = store.addPosition('Director', true);
      const boss = store.addEmployee({}, [director]);
      store.addEmployee({ lastName: 'Второй' }, [director]);
      const token = await tokenWith(ALL);

      await put(`/api/v1/employees/${boss.id}`, token, { positionIds: [] }).expect(200);
      await del(`/api/v1/employees/${boss.id}`, token).expect(200);
    });

    it('уволенный руководитель за действующего не считается', async () => {
      const director = store.addPosition('Director', true);
      const boss = store.addEmployee({}, [director]);
      // Второй Director есть, но выведен из штата — вход ему закрыт,
      // и разблокировать систему он не поможет.
      store.addEmployee({ lastName: 'Уволенный', status: EmployeeStatus.INACTIVE }, [director]);

      await put(`/api/v1/employees/${boss.id}`, await tokenWith(ALL), {
        positionIds: [],
      }).expect(422);
    });

    it('обычная позиция под правило не подпадает', async () => {
      const mentor = store.addPosition('Mentor');
      const employee = store.addEmployee({}, [mentor]);

      await put(`/api/v1/employees/${employee.id}`, await tokenWith(ALL), {
        positionIds: [],
      }).expect(200);
    });
  });

  describe('Список и фильтры (ТЗ 5.14)', () => {
    it('{ data, meta }, порядок по фамилии и позиции в строке', async () => {
      const mentor = store.addPosition('Mentor');
      store.addEmployee({ lastName: 'Раҳимов', firstName: 'Фаррух' }, [mentor]);
      store.addEmployee({ lastName: 'Каримова', firstName: 'Нигина' });

      const response = await get('/api/v1/employees', await tokenWith(ALL)).expect(200);
      const page = response.body as { data: EmployeeBody[]; meta: { total: number } };

      expect(page.meta).toMatchObject({ total: 2, page: 1, limit: 20 });
      expect(page.data.map(({ lastName }) => lastName)).toEqual(['Каримова', 'Раҳимов']);
      expect(page.data[1]?.positions.map(({ name }) => name)).toEqual(['Mentor']);
    });

    it('фильтр по позиции и есть список менторов (ТЗ 5.4)', async () => {
      const mentor = store.addPosition('Mentor');
      const manager = store.addPosition('Manager');
      store.addEmployee({ lastName: 'Ментор' }, [mentor]);
      store.addEmployee({ lastName: 'Менеджер' }, [manager]);

      const response = await get(
        `/api/v1/employees?positionId=${mentor.id}`,
        await tokenWith(ALL),
      ).expect(200);

      expect(
        (response.body as { data: EmployeeBody[] }).data.map(({ lastName }) => lastName),
      ).toEqual(['Ментор']);
    });

    it('фильтры по статусу, филиалу и наличию логина', async () => {
      const branch = store.addBranch();
      const withAccount = store.addEmployee({ lastName: 'Слогином', branch });
      store.addAccount(withAccount);
      store.addEmployee({ lastName: 'Безлогина', status: EmployeeStatus.INACTIVE });
      const token = await tokenWith(ALL);

      const byStatus = await get(
        `/api/v1/employees?status=${EmployeeStatus.INACTIVE}`,
        token,
      ).expect(200);
      expect((byStatus.body as { meta: { total: number } }).meta.total).toBe(1);

      const byBranch = await get(`/api/v1/employees?branchId=${branch.id}`, token).expect(200);
      expect((byBranch.body as { meta: { total: number } }).meta.total).toBe(1);

      const byAccount = await get('/api/v1/employees?hasAccount=false', token).expect(200);
      expect(
        (byAccount.body as { data: EmployeeBody[] }).data.map(({ lastName }) => lastName),
      ).toEqual(['Безлогина']);
    });

    it('поиск по фамилии и по телефону', async () => {
      store.addEmployee({ lastName: 'Раҳимов', phone: '+992905550001' });
      store.addEmployee({ lastName: 'Каримова', phone: '+992905550002' });
      const token = await tokenWith(ALL);

      const byName = await get('/api/v1/employees?search=каримов', token).expect(200);
      expect((byName.body as { meta: { total: number } }).meta.total).toBe(1);

      const byPhone = await get('/api/v1/employees?search=5550001', token).expect(200);
      expect((byPhone.body as { data: EmployeeBody[] }).data[0]?.lastName).toBe('Раҳимов');
    });

    it('400 на неизвестное поле сортировки', async () => {
      await get('/api/v1/employees?sort=salary', await tokenWith(ALL)).expect(400);
    });

    it('карточка отдаёт группы под менторством (ТЗ 5.4, 5.5)', async () => {
      const employee = store.addEmployee();
      store.addMentorGroup(
        employee,
        { id: randomUUID(), name: 'Frontend-1', courseId: randomUUID(), courseTitle: 'Frontend' },
        GroupMentorRole.TEACHING,
      );

      const card = dataOf<EmployeeBody>(
        await get(`/api/v1/employees/${employee.id}`, await tokenWith(ALL)).expect(200),
      );

      expect(card.groups).toEqual([
        expect.objectContaining({
          name: 'Frontend-1',
          courseTitle: 'Frontend',
          role: GroupMentorRole.TEACHING,
        }),
      ]);
    });

    it('404 на неизвестного и 400 на не-UUID в пути', async () => {
      const token = await tokenWith(ALL);

      await get(`/api/v1/employees/${randomUUID()}`, token).expect(404);
      await get('/api/v1/employees/не-uuid', token).expect(400);
    });
  });

  describe('Правка карточки', () => {
    it('непереданное сохраняется, пустая строка очищает и снимает филиал', async () => {
      const branch = store.addBranch();
      const employee = store.addEmployee({
        branch,
        experience: '5 лет',
        middleName: 'Саидович',
        telegram: '@farrukh',
      });

      const updated = dataOf<EmployeeBody>(
        await put(`/api/v1/employees/${employee.id}`, await tokenWith(ALL), {
          experience: '',
          branchId: '',
        }).expect(200),
      );

      expect(updated).toMatchObject({
        experience: null,
        branch: null,
        middleName: 'Саидович',
        telegram: '@farrukh',
      });
    });

    it('400 на пустой телефон — номер не изменился', async () => {
      const employee = store.addEmployee({ phone: '+992905550001' });

      await put(`/api/v1/employees/${employee.id}`, await tokenWith(ALL), { phone: '' }).expect(
        400,
      );
      expect(store.employees.get(employee.id)?.phone).toBe('+992905550001');
    });

    it('свой телефон — не конфликт, чужой — 409', async () => {
      const employee = store.addEmployee({ phone: '+992905550001' });
      store.addEmployee({ phone: '+992905550002' });
      const token = await tokenWith(ALL);

      await put(`/api/v1/employees/${employee.id}`, token, { phone: '+992905550001' }).expect(200);
      await put(`/api/v1/employees/${employee.id}`, token, { phone: '+992905550002' }).expect(409);
    });

    it('404 на неизвестного', async () => {
      await put(`/api/v1/employees/${randomUUID()}`, await tokenWith(ALL), {
        telegram: '@x',
      }).expect(404);
    });
  });

  describe('Удаление', () => {
    it('удаляет «чистый» профиль вместе с аккаунтом (ТЗ 3.1)', async () => {
      const employee = store.addEmployee({ lastName: 'Раҳимов', firstName: 'Фаррух' });
      const account = store.addAccount(employee);

      const deleted = dataOf<DeletedBody>(
        await del(`/api/v1/employees/${employee.id}`, await tokenWith(ALL)).expect(200),
      );

      expect(deleted).toEqual({
        id: employee.id,
        fullName: 'Раҳимов Фаррух',
        accountDeleted: true,
      });
      expect(store.employees.has(employee.id)).toBe(false);
      expect(store.accounts.has(account.id)).toBe(false);
    });

    it('409 с перечислением следов работы — профиль остался', async () => {
      const employee = store.addEmployee();
      store.setTrace(employee.id, { mentorGroups: 2, submittedWeeks: 5 });

      const response = await del(`/api/v1/employees/${employee.id}`, await tokenWith(ALL)).expect(
        409,
      );

      const message = JSON.stringify(response.body);
      expect(message).toContain('группы под менторством (2)');
      expect(message).toContain('финализированные недели журнала (5)');
      expect(message).not.toContain('(0)');
      expect(store.employees.has(employee.id)).toBe(true);
    });

    it('одной заметки о студенте довольно, чтобы отказать', async () => {
      const employee = store.addEmployee();
      store.setTrace(employee.id, { authoredFeedback: 1 });

      await del(`/api/v1/employees/${employee.id}`, await tokenWith(ALL)).expect(409);
    });

    it('404 на повторное удаление', async () => {
      const employee = store.addEmployee();
      const token = await tokenWith(ALL);

      await del(`/api/v1/employees/${employee.id}`, token).expect(200);
      await del(`/api/v1/employees/${employee.id}`, token).expect(404);
    });
  });

  describe('OpenAPI', () => {
    it('два пути сотрудников описаны, создание отвечает 201', () => {
      const document = buildOpenApiDocument(app);

      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining(['/api/v1/employees', '/api/v1/employees/{id}']),
      );

      const collection = document.paths['/api/v1/employees'];
      expect(collection?.get?.responses['200']).toBeDefined();
      expect(collection?.post?.responses['201']).toBeDefined();
      expect(collection?.post?.responses['200']).toBeUndefined();

      const item = document.paths['/api/v1/employees/{id}'];
      expect(item?.put?.responses['200']).toBeDefined();
      expect(item?.delete?.responses['200']).toBeDefined();
    });
  });
});
