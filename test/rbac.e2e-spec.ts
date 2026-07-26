import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus, AccountType, Locale } from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { PhoneModule } from 'src/phone/phone.module';
import { PERMISSION_CATALOG } from 'src/rbac/permission-catalog';
import { AdminUsersRepository } from 'src/rbac/admin-users.repository';
import { PositionsRepository } from 'src/rbac/positions.repository';
import { RbacAdminModule } from 'src/rbac/rbac-admin.module';
import { RbacModule } from 'src/rbac/rbac.module';
import { RbacRepository } from 'src/rbac/rbac.repository';

interface PermissionRow {
  id: string;
  code: string;
  section: string;
  action: string;
  description: string | null;
  isEnabled: boolean;
  isSystem: boolean;
}

interface PositionRow {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  createdAt: Date;
  permissionIds: Set<string>;
}

interface ProfileRow {
  id: string;
  firstName: string;
  lastName: string;
}

interface AccountRow {
  id: string;
  phone: string;
  email: string;
  type: AccountType;
  status: AccountStatus;
  locale: Locale;
  lastLoginAt: Date | null;
  createdAt: Date;
  student: ProfileRow | null;
  employee: ProfileRow | null;
}

interface AccountForRolesRow {
  id: string;
  type: AccountType;
  employee: { id: string; positionIds: string[] } | null;
}

interface RoleRow {
  id: string;
  name: string;
  isSystem: boolean;
}

// Тела ответов у supertest типизированы как `any`; чтение через эти формы
// возвращает проверяемые типы, а не «что угодно».
interface PositionBody {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissionsCount: number;
  employeesCount: number;
  permissions: string[];
}

interface AdminUserBody {
  id: string;
  type: AccountType;
  fullName: string | null;
  roles: RoleRow[];
}

interface CatalogBody {
  total: number;
  sections: {
    section: string;
    title: string;
    permissions: { code: string; isEnabled: boolean; isSystem: boolean }[];
  }[];
}

/** `{ data }` ответа с ожидаемым типом. */
const dataOf = <T>(response: { body: unknown }): T => (response.body as { data: T }).data;

/**
 * Хранилище RBAC в памяти вместо PostgreSQL. Подставляется сразу под три
 * репозитория — таблицы `permissions`, `positions` и `employee_positions`
 * связаны между собой, и делить их на три несогласованных заглушки значило бы
 * проверять не то поведение, которое даёт настоящая БД.
 *
 * Каталог прав засеян из кода: при `app.init()` по нему проходит настоящая
 * синхронизация и создаёт системную позицию `Director` — как в проде.
 */
class InMemoryRbacStore {
  readonly permissions = new Map<string, PermissionRow>();
  readonly positions = new Map<string, PositionRow>();
  readonly accounts = new Map<string, AccountRow>();
  /** Назначения позиций: `${employeeId}:${positionId}`. */
  readonly assignments = new Set<string>();

  constructor() {
    for (const definition of PERMISSION_CATALOG) {
      this.permissions.set(definition.code, {
        id: `perm-${definition.code}`,
        code: definition.code,
        section: definition.section,
        action: definition.action,
        description: definition.description,
        isEnabled: true,
        isSystem: definition.isSystem,
      });
    }
  }

  // ─── Подготовка данных теста ───

  addPosition(name: string, codes: string[], isSystem = false): PositionRow {
    const position: PositionRow = {
      id: randomUUID(),
      name,
      description: null,
      isSystem,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      permissionIds: new Set(codes.map((code) => this.permissionId(code))),
    };
    this.positions.set(position.id, position);

    return position;
  }

  /** Сотрудник с аккаунтом и, при необходимости, с позицией, дающей права. */
  addEmployee(codes: string[] | null, overrides: Partial<AccountRow> = {}): AccountRow {
    const employeeId = randomUUID();
    const account: AccountRow = {
      id: randomUUID(),
      phone: `+9929${String(this.accounts.size).padStart(8, '0')}`,
      email: `employee${String(this.accounts.size)}@omuz.tj`,
      type: AccountType.EMPLOYEE,
      status: AccountStatus.ACTIVE,
      locale: Locale.RU,
      lastLoginAt: null,
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
      student: null,
      employee: { id: employeeId, firstName: 'Сотрудник', lastName: 'Тестовый' },
      ...overrides,
    };
    this.accounts.set(account.id, account);

    if (codes !== null) {
      const position = this.addPosition(`Position-${String(this.positions.size)}`, codes);
      this.assign(employeeId, position.id);
    }

    return account;
  }

  addStudent(): AccountRow {
    const account: AccountRow = {
      id: randomUUID(),
      phone: `+9925${String(this.accounts.size).padStart(8, '0')}`,
      email: `student${String(this.accounts.size)}@omuz.tj`,
      type: AccountType.STUDENT,
      status: AccountStatus.ACTIVE,
      locale: Locale.RU,
      lastLoginAt: null,
      createdAt: new Date('2026-07-12T00:00:00.000Z'),
      student: { id: randomUUID(), firstName: 'Нилуфар', lastName: 'Каримова' },
      employee: null,
    };
    this.accounts.set(account.id, account);

    return account;
  }

  assign(employeeId: string, positionId: string): void {
    this.assignments.add(`${employeeId}:${positionId}`);
  }

  positionByName(name: string): PositionRow {
    const found = [...this.positions.values()].find((position) => position.name === name);
    if (!found) throw new Error(`Позиции ${name} нет: тест построен неверно`);

    return found;
  }

  permissionId(code: string): string {
    const permission = this.permissions.get(code);
    if (!permission) throw new Error(`Права ${code} нет в каталоге: тест построен неверно`);

    return permission.id;
  }

  // ─── RbacRepository ───

  findAccountPermissionCodes(accountId: string): Promise<{ code: string }[]> {
    const account = this.accounts.get(accountId);
    const employeeId = account?.employee?.id;
    if (employeeId === undefined) return Promise.resolve([]);

    const codes = new Set<string>();
    for (const position of this.positions.values()) {
      if (!this.assignments.has(`${employeeId}:${position.id}`)) continue;

      for (const permission of this.permissions.values()) {
        // Выключенное в каталоге право не выдаётся никому (ТЗ 5.15) —
        // это отсекает и настоящий запрос через `isEnabled: true`.
        if (permission.isEnabled && position.permissionIds.has(permission.id)) {
          codes.add(permission.code);
        }
      }
    }

    return Promise.resolve([...codes].sort().map((code) => ({ code })));
  }

  findAllPermissions(): Promise<PermissionRow[]> {
    return Promise.resolve([...this.permissions.values()]);
  }

  createPermissions(): Promise<number> {
    return Promise.resolve(0);
  }

  updatePermission(): Promise<void> {
    return Promise.resolve();
  }

  setPermissionsEnabled(enableIds: string[], disableIds: string[]): Promise<number> {
    let changed = 0;
    for (const permission of this.permissions.values()) {
      if (enableIds.includes(permission.id) && !permission.isEnabled) {
        permission.isEnabled = true;
        changed += 1;
      }
      if (disableIds.includes(permission.id) && permission.isEnabled) {
        permission.isEnabled = false;
        changed += 1;
      }
    }

    return Promise.resolve(changed);
  }

  syncSystemPosition(name: string, description: string): Promise<number> {
    const existing = [...this.positions.values()].find((position) => position.name === name);
    const position = existing ?? this.addPosition(name, [], true);
    position.isSystem = true;
    position.description = description;

    let granted = 0;
    for (const permission of this.permissions.values()) {
      if (!position.permissionIds.has(permission.id)) {
        position.permissionIds.add(permission.id);
        granted += 1;
      }
    }

    return Promise.resolve(granted);
  }

  // ─── PositionsRepository ───

  findPositions(params: {
    search?: string;
    sort: string;
    order: string;
    skip: number;
    take: number;
  }): Promise<{ rows: unknown[]; total: number }> {
    const search = params.search?.toLowerCase();
    const matched = [...this.positions.values()].filter(
      (position) =>
        search === undefined ||
        position.name.toLowerCase().includes(search) ||
        (position.description ?? '').toLowerCase().includes(search),
    );

    matched.sort((a, b) => {
      const asc =
        params.sort === 'name' ? a.name.localeCompare(b.name) : +a.createdAt - +b.createdAt;
      return params.order === 'asc' ? asc : -asc;
    });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take).map((p) => this.listRow(p)),
      total: matched.length,
    });
  }

  findById(id: string): Promise<unknown> {
    const position = this.positions.get(id);

    return Promise.resolve(position ? this.detailRow(position) : null);
  }

  findByName(name: string): Promise<{ id: string; name: string } | null> {
    const found = [...this.positions.values()].find(
      (position) => position.name.toLowerCase() === name.toLowerCase(),
    );

    return Promise.resolve(found ? { id: found.id, name: found.name } : null);
  }

  findPermissionsByCodes(codes: string[]): Promise<{ id: string; code: string }[]> {
    return Promise.resolve(
      codes
        .map((code) => this.permissions.get(code))
        .filter((permission): permission is PermissionRow => permission !== undefined)
        .map(({ id, code }) => ({ id, code })),
    );
  }

  create(input: {
    name: string;
    description: string | null;
    permissionIds: string[];
  }): Promise<unknown> {
    const position: PositionRow = {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      isSystem: false,
      createdAt: new Date('2026-07-26T12:00:00.000Z'),
      permissionIds: new Set(input.permissionIds),
    };
    this.positions.set(position.id, position);

    return Promise.resolve(this.detailRow(position));
  }

  update(
    id: string,
    input: { name?: string; description?: string | null; permissionIds?: string[] },
  ): Promise<unknown> {
    const position = this.positions.get(id);
    if (!position) throw new Error('Позиции нет: тест построен неверно');

    if (input.name !== undefined) position.name = input.name;
    if (input.description !== undefined) position.description = input.description;
    if (input.permissionIds !== undefined) position.permissionIds = new Set(input.permissionIds);

    return Promise.resolve(this.detailRow(position));
  }

  delete(id: string): Promise<void> {
    this.positions.delete(id);

    return Promise.resolve();
  }

  // ─── AdminUsersRepository ───

  findAccounts(params: {
    search?: string;
    type?: AccountType;
    status?: AccountStatus;
    skip: number;
    take: number;
  }): Promise<{ rows: unknown[]; total: number }> {
    const search = params.search?.toLowerCase();
    const matched = [...this.accounts.values()].filter((account) => {
      if (params.type !== undefined && account.type !== params.type) return false;
      if (params.status !== undefined && account.status !== params.status) return false;
      if (search === undefined) return true;

      const profile = account.employee ?? account.student;

      return (
        account.phone.includes(search) ||
        account.email.toLowerCase().includes(search) ||
        `${profile?.firstName ?? ''} ${profile?.lastName ?? ''}`.toLowerCase().includes(search)
      );
    });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take).map((account) => ({
        ...account,
        employee: account.employee
          ? {
              ...account.employee,
              positions: this.rolesOf(account.employee.id).map((position) => ({ position })),
            }
          : null,
      })),
      total: matched.length,
    });
  }

  findAccountForRoles(accountId: string): Promise<AccountForRolesRow | null> {
    const account = this.accounts.get(accountId);
    if (!account) return Promise.resolve(null);

    return Promise.resolve({
      id: account.id,
      type: account.type,
      employee: account.employee
        ? {
            id: account.employee.id,
            positionIds: this.rolesOf(account.employee.id).map(({ id }) => id),
          }
        : null,
    });
  }

  findPositionsByIds(ids: string[]): Promise<RoleRow[]> {
    return Promise.resolve(
      ids
        .map((id) => this.positions.get(id))
        .filter((position): position is PositionRow => position !== undefined)
        .map(({ id, name, isSystem }) => ({ id, name, isSystem })),
    );
  }

  findEmployeeRoles(employeeId: string): Promise<RoleRow[]> {
    return Promise.resolve(this.rolesOf(employeeId));
  }

  assignPositions(employeeId: string, positionIds: string[]): Promise<number> {
    let changed = 0;
    for (const positionId of positionIds) {
      const key = `${employeeId}:${positionId}`;
      if (!this.assignments.has(key)) {
        this.assignments.add(key);
        changed += 1;
      }
    }

    return Promise.resolve(changed);
  }

  removePositions(employeeId: string, positionIds: string[]): Promise<number> {
    let changed = 0;
    for (const positionId of positionIds) {
      if (this.assignments.delete(`${employeeId}:${positionId}`)) changed += 1;
    }

    return Promise.resolve(changed);
  }

  countPositionAssignments(positionId: string): Promise<number> {
    const holders = [...this.assignments].filter((key) => key.endsWith(`:${positionId}`));

    return Promise.resolve(holders.length);
  }

  // ─── Вспомогательное ───

  private rolesOf(employeeId: string): RoleRow[] {
    return [...this.positions.values()]
      .filter((position) => this.assignments.has(`${employeeId}:${position.id}`))
      .map(({ id, name, isSystem }) => ({ id, name, isSystem }));
  }

  private listRow(position: PositionRow): unknown {
    return {
      id: position.id,
      name: position.name,
      description: position.description,
      isSystem: position.isSystem,
      createdAt: position.createdAt,
      _count: {
        permissions: position.permissionIds.size,
        employees: [...this.assignments].filter((key) => key.endsWith(`:${position.id}`)).length,
      },
    };
  }

  private detailRow(position: PositionRow): unknown {
    const codes = [...this.permissions.values()]
      .filter((permission) => position.permissionIds.has(permission.id))
      .map((permission) => ({ permission: { code: permission.code } }));

    return { ...(this.listRow(position) as object), permissions: codes };
  }
}

describe('RBAC: позиции и администрирование (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryRbacStore;
  let tokens: TokenService;

  /** Токен сотрудника, которому выданы перечисленные права. */
  const actor = async (...codes: string[]): Promise<string> => {
    const account = store.addEmployee(codes);

    return (
      await tokens.issuePair({ sub: account.id, sid: randomUUID(), type: AccountType.EMPLOYEE })
    ).accessToken;
  };

  beforeEach(async () => {
    store = new InMemoryRbacStore();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        PhoneModule,
        AuthModule,
        RbacModule,
        RbacAdminModule,
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
      .useValue(store)
      // Два репозитория объявляют `findMany` с разным смыслом, поэтому в хранилище
      // методы названы по сущности, а здесь разводятся тонкими переходниками.
      .overrideProvider(PositionsRepository)
      .useValue({
        findMany: (params: Parameters<InMemoryRbacStore['findPositions']>[0]) =>
          store.findPositions(params),
        findById: (id: string) => store.findById(id),
        findByName: (name: string) => store.findByName(name),
        findPermissionsByCodes: (codes: string[]) => store.findPermissionsByCodes(codes),
        create: (input: Parameters<InMemoryRbacStore['create']>[0]) => store.create(input),
        update: (id: string, input: Parameters<InMemoryRbacStore['update']>[1]) =>
          store.update(id, input),
        delete: (id: string) => store.delete(id),
      })
      .overrideProvider(AdminUsersRepository)
      .useValue({
        findMany: (params: Parameters<InMemoryRbacStore['findAccounts']>[0]) =>
          store.findAccounts(params),
        findAccountForRoles: (id: string) => store.findAccountForRoles(id),
        findPositionsByIds: (ids: string[]) => store.findPositionsByIds(ids),
        findEmployeeRoles: (id: string) => store.findEmployeeRoles(id),
        assignPositions: (employeeId: string, ids: string[]) =>
          store.assignPositions(employeeId, ids),
        removePositions: (employeeId: string, ids: string[]) =>
          store.removePositions(employeeId, ids),
        countPositionAssignments: (id: string) => store.countPositionAssignments(id),
      })
      .compile();

    tokens = moduleRef.get(TokenService, { strict: false });

    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    // `init()` запускает синхронизацию каталога: она заводит системную позицию
    // Director и выдаёт ей весь каталог прав — как при старте приложения.
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  const get = (url: string, token: string) =>
    request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);

  const send = (
    method: 'post' | 'put' | 'delete',
    url: string,
    token: string,
    body: Record<string, unknown>,
  ) => request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`).send(body);

  describe('Доступ к справочнику позиций', () => {
    it('без токена — 401', async () => {
      await request(app.getHttpServer()).get('/api/v1/positions').expect(401);
    });

    it('студент не видит справочник прав — 403 (ТЗ 3.2)', async () => {
      const account = store.addStudent();
      const token = (
        await tokens.issuePair({ sub: account.id, sid: randomUUID(), type: AccountType.STUDENT })
      ).accessToken;

      await get('/api/v1/positions', token).expect(403);
    });

    it('сотрудник без прав — 403', async () => {
      const response = await get('/api/v1/positions', await actor()).expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('право на просмотр не даёт права на создание', async () => {
      const token = await actor('Permission.Positions.Views');

      await get('/api/v1/positions', token).expect(200);
      await send('post', '/api/v1/positions', token, { name: 'Accountant' }).expect(403);
    });
  });

  describe('Справочник позиций (ТЗ 5.14)', () => {
    it('отдаёт { data, meta } и системную позицию Director со всем каталогом', async () => {
      const response = await get(
        '/api/v1/positions?limit=100',
        await actor('Permission.Positions.Views'),
      ).expect(200);

      expect(response.body.meta).toMatchObject({ page: 1, limit: 100 });

      const director = dataOf<PositionBody[]>(response).find(
        (position) => position.name === 'Director',
      );
      expect(director).toMatchObject({
        isSystem: true,
        permissionsCount: PERMISSION_CATALOG.length,
      });
    });

    it('создаёт позицию с правами и отдаёт её карточку', async () => {
      const token = await actor('Permission.Positions.Create', 'Permission.Positions.Views');

      const response = await send('post', '/api/v1/positions', token, {
        name: 'Accountant',
        description: 'Ведёт оплаты',
        permissions: ['Permission.Students.Views', 'Permission.Coins.Create'],
      }).expect(201);

      expect(response.body.data).toMatchObject({
        name: 'Accountant',
        description: 'Ведёт оплаты',
        isSystem: false,
        permissionsCount: 2,
        employeesCount: 0,
      });
      expect(response.body.data.permissions).toEqual([
        'Permission.Coins.Create',
        'Permission.Students.Views',
      ]);
    });

    it('409 на название, занятое без учёта регистра', async () => {
      const token = await actor('Permission.Positions.Create');

      const response = await send('post', '/api/v1/positions', token, { name: 'director' }).expect(
        409,
      );

      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('400 на код права, которого нет в каталоге', async () => {
      const token = await actor('Permission.Positions.Create');

      const response = await send('post', '/api/v1/positions', token, {
        name: 'Accountant',
        permissions: ['Permission.Students.Viwes'],
      }).expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('422 на выдачу прав Accounting обычной позиции (ТЗ 3.2: только Director)', async () => {
      const token = await actor('Permission.Positions.Create');

      const response = await send('post', '/api/v1/positions', token, {
        name: 'Accountant',
        permissions: ['Permission.Accounting.Views'],
      }).expect(422);

      expect(response.body.error.code).toBe('UNPROCESSABLE_ENTITY');
      expect(response.body.error.message).toContain('Director');
    });

    it('PUT заменяет набор прав целиком', async () => {
      const token = await actor('Permission.Positions.Update', 'Permission.Positions.Views');
      const position = store.addPosition('Manager', [
        'Permission.Students.Views',
        'Permission.Groups.Views',
      ]);

      const response = await send('put', `/api/v1/positions/${position.id}`, token, {
        permissions: ['Permission.Leads.Views'],
      }).expect(200);

      expect(response.body.data.permissions).toEqual(['Permission.Leads.Views']);
    });

    it('422 на правку системной позиции Director', async () => {
      const token = await actor('Permission.Positions.Update');
      const director = store.positionByName('Director');

      const response = await send('put', `/api/v1/positions/${director.id}`, token, {
        name: 'Boss',
      }).expect(422);

      expect(response.body.error.message).toContain('Director');
      expect(store.positionByName('Director').name).toBe('Director');
    });

    it('422 на удаление системной позиции', async () => {
      const token = await actor('Permission.Positions.Delete');
      const director = store.positionByName('Director');

      await send('delete', `/api/v1/positions/${director.id}`, token, {}).expect(422);
      expect(store.positions.has(director.id)).toBe(true);
    });

    it('409 на удаление позиции, которую занимают сотрудники', async () => {
      const token = await actor('Permission.Positions.Delete');
      const employee = store.addEmployee(null);
      const position = store.addPosition('Mentor', ['Permission.Journal.Views']);
      store.assign(employee.employee?.id ?? '', position.id);

      const response = await send('delete', `/api/v1/positions/${position.id}`, token, {}).expect(
        409,
      );

      expect(response.body.error.code).toBe('CONFLICT');
      expect(store.positions.has(position.id)).toBe(true);
    });

    it('удаляет свободную позицию', async () => {
      const token = await actor('Permission.Positions.Delete');
      const position = store.addPosition('Temp', []);

      const response = await send('delete', `/api/v1/positions/${position.id}`, token, {}).expect(
        200,
      );

      expect(response.body.data).toEqual({ id: position.id, name: 'Temp' });
      expect(store.positions.has(position.id)).toBe(false);
    });

    it('404 на неизвестную позицию и 400 на не-UUID', async () => {
      const token = await actor('Permission.Positions.Views');

      await get(`/api/v1/positions/${randomUUID()}`, token).expect(404);
      await get('/api/v1/positions/не-uuid', token).expect(400);
    });
  });

  describe('Administration → Users (ТЗ 5.15)', () => {
    it('список отдаёт Type/Roles/Phone и имя из профиля', async () => {
      const token = await actor('Permission.Administration.ViewUsers');
      store.addStudent();

      const response = await get('/api/v1/admin/users?limit=100', token).expect(200);

      const users = dataOf<AdminUserBody[]>(response);

      const student = users.find((user) => user.type === AccountType.STUDENT);
      expect(student).toMatchObject({ fullName: 'Каримова Нилуфар', roles: [] });

      const withRole = users.find((user) => user.roles.length > 0);
      expect(withRole?.roles[0]).toMatchObject({ isSystem: false });
    });

    it('фильтр по типу аккаунта', async () => {
      const token = await actor('Permission.Administration.ViewUsers');
      store.addStudent();

      const response = await get(`/api/v1/admin/users?type=${AccountType.STUDENT}`, token).expect(
        200,
      );

      expect(response.body.data).toHaveLength(1);
      expect(response.body.meta.total).toBe(1);
    });

    it('назначенная роль начинает действовать сразу, без повторного входа (ТЗ 3.2)', async () => {
      const admin = await actor('Permission.Administration.ManageUserRoles');

      // Сотрудник без позиций: своих прав у него нет.
      const target = store.addEmployee(null);
      const token = (
        await tokens.issuePair({ sub: target.id, sid: randomUUID(), type: AccountType.EMPLOYEE })
      ).accessToken;

      await get('/api/v1/positions', token).expect(403);

      const position = store.addPosition('Viewer', ['Permission.Positions.Views']);
      const response = await send('post', `/api/v1/admin/users/${target.id}/roles`, admin, {
        positionIds: [position.id],
      }).expect(200);

      expect(response.body.data).toMatchObject({ changed: 1, roles: [{ name: 'Viewer' }] });

      // Права читаются из БД на каждый запрос, поэтому старый токен уже работает.
      await get('/api/v1/positions', token).expect(200);
    });

    it('снятая роль перестаёт действовать сразу', async () => {
      const admin = await actor('Permission.Administration.ManageUserRoles');
      const target = store.addEmployee(['Permission.Positions.Views']);
      const token = (
        await tokens.issuePair({ sub: target.id, sid: randomUUID(), type: AccountType.EMPLOYEE })
      ).accessToken;

      await get('/api/v1/positions', token).expect(200);

      const roles = await store.findEmployeeRoles(target.employee?.id ?? '');
      const response = await send('delete', `/api/v1/admin/users/${target.id}/roles`, admin, {
        positionIds: roles.map(({ id }) => id),
      }).expect(200);

      expect(response.body.data).toMatchObject({ changed: 1, roles: [] });
      await get('/api/v1/positions', token).expect(403);
    });

    it('повторное назначение той же роли ничего не меняет', async () => {
      const admin = await actor('Permission.Administration.ManageUserRoles');
      const target = store.addEmployee(null);
      const position = store.addPosition('Viewer', ['Permission.Positions.Views']);

      await send('post', `/api/v1/admin/users/${target.id}/roles`, admin, {
        positionIds: [position.id],
      }).expect(200);

      const response = await send('post', `/api/v1/admin/users/${target.id}/roles`, admin, {
        positionIds: [position.id],
      }).expect(200);

      expect(response.body.data).toMatchObject({ changed: 0, roles: [{ name: 'Viewer' }] });
    });

    it('422 на попытку выдать роль аккаунту студента', async () => {
      const admin = await actor('Permission.Administration.ManageUserRoles');
      const student = store.addStudent();
      const position = store.addPosition('Viewer', ['Permission.Positions.Views']);

      const response = await send('post', `/api/v1/admin/users/${student.id}/roles`, admin, {
        positionIds: [position.id],
      }).expect(422);

      expect(response.body.error.code).toBe('UNPROCESSABLE_ENTITY');
    });

    it('404 на неизвестный аккаунт, 422 на неизвестную позицию, 400 на пустой список', async () => {
      const admin = await actor('Permission.Administration.ManageUserRoles');
      const target = store.addEmployee(null);

      await send('post', `/api/v1/admin/users/${randomUUID()}/roles`, admin, {
        positionIds: [randomUUID()],
      }).expect(404);

      await send('post', `/api/v1/admin/users/${target.id}/roles`, admin, {
        positionIds: [randomUUID()],
      }).expect(422);

      await send('post', `/api/v1/admin/users/${target.id}/roles`, admin, {
        positionIds: [],
      }).expect(400);
    });

    it('422 на снятие Director с последнего руководителя', async () => {
      const admin = await actor('Permission.Administration.ManageUserRoles');
      const director = store.positionByName('Director');
      const target = store.addEmployee(null);
      store.assign(target.employee?.id ?? '', director.id);

      const response = await send('delete', `/api/v1/admin/users/${target.id}/roles`, admin, {
        positionIds: [director.id],
      }).expect(422);

      expect(response.body.error.message).toContain('Director');
      expect(await store.countPositionAssignments(director.id)).toBe(1);
    });

    it('назначение ролей само требует права', async () => {
      const token = await actor('Permission.Administration.ViewUsers');
      const target = store.addEmployee(null);
      const position = store.addPosition('Viewer', []);

      await send('post', `/api/v1/admin/users/${target.id}/roles`, token, {
        positionIds: [position.id],
      }).expect(403);
    });
  });

  describe('Administration → Permission (ТЗ 5.15)', () => {
    it('отдаёт каталог целиком, сгруппированный по разделам', async () => {
      const token = await actor('Permission.Administration.ViewPermissions');

      const response = await get('/api/v1/admin/permissions', token).expect(200);

      const catalog = dataOf<CatalogBody>(response);

      expect(catalog.total).toBe(PERMISSION_CATALOG.length);

      const students = catalog.sections.find((section) => section.section === 'Students');
      expect(students?.title).toBe('Студенты');
      expect(students?.permissions[0]).toMatchObject({
        code: 'Permission.Students.Views',
        isEnabled: true,
        isSystem: false,
      });
    });

    it('фильтр по разделу', async () => {
      const token = await actor('Permission.Administration.ViewPermissions');

      const response = await get('/api/v1/admin/permissions?section=Accounting', token).expect(200);

      const catalog = dataOf<CatalogBody>(response);

      expect(catalog.sections).toHaveLength(1);
      expect(catalog.sections[0]?.section).toBe('Accounting');
    });

    it('400 на неизвестный раздел', async () => {
      const token = await actor('Permission.Administration.ViewPermissions');

      await get('/api/v1/admin/permissions?section=Nonexistent', token).expect(400);
    });

    it('выключенное право перестаёт действовать для всех позиций (ТЗ 5.15)', async () => {
      const admin = await actor('Permission.Administration.ManagePermissions');
      const viewer = await actor('Permission.Positions.Views');

      await get('/api/v1/positions', viewer).expect(200);

      await send('put', '/api/v1/admin/permissions', admin, {
        permissions: [{ code: 'Permission.Positions.Views', isEnabled: false }],
      }).expect(200);

      await get('/api/v1/positions', viewer).expect(403);
    });

    it('включение возвращает право в работу', async () => {
      const admin = await actor('Permission.Administration.ManagePermissions');
      const viewer = await actor('Permission.Positions.Views');

      const toggle = (isEnabled: boolean) =>
        send('put', '/api/v1/admin/permissions', admin, {
          permissions: [{ code: 'Permission.Positions.Views', isEnabled }],
        }).expect(200);

      await toggle(false);
      await get('/api/v1/positions', viewer).expect(403);

      const response = await toggle(true);
      await get('/api/v1/positions', viewer).expect(200);

      const positions = dataOf<CatalogBody>(response).sections.find(
        (section) => section.section === 'Positions',
      );
      expect(
        positions?.permissions.find(
          (permission) => permission.code === 'Permission.Positions.Views',
        )?.isEnabled,
      ).toBe(true);
    });

    it('422 на попытку выключить служебное право', async () => {
      const admin = await actor('Permission.Administration.ManagePermissions');

      const response = await send('put', '/api/v1/admin/permissions', admin, {
        permissions: [{ code: 'Permission.Administration.ManagePermissions', isEnabled: false }],
      }).expect(422);

      expect(response.body.error.code).toBe('UNPROCESSABLE_ENTITY');
    });

    it('400 на неизвестный код права и на пустой список', async () => {
      const admin = await actor('Permission.Administration.ManagePermissions');

      await send('put', '/api/v1/admin/permissions', admin, {
        permissions: [{ code: 'Permission.Nope.Nope', isEnabled: false }],
      }).expect(400);

      await send('put', '/api/v1/admin/permissions', admin, { permissions: [] }).expect(400);
    });

    it('переключение каталога требует своего права: просмотра недостаточно', async () => {
      const token = await actor('Permission.Administration.ViewPermissions');

      await send('put', '/api/v1/admin/permissions', token, {
        permissions: [{ code: 'Permission.Positions.Views', isEnabled: false }],
      }).expect(403);
    });
  });

  describe('OpenAPI', () => {
    it('документ описывает новые маршруты и коды ответов', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/docs/json').expect(200);
      const document = response.body as {
        paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
      };

      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/positions',
          '/api/v1/positions/{id}',
          '/api/v1/admin/users',
          '/api/v1/admin/users/{id}/roles',
          '/api/v1/admin/permissions',
        ]),
      );

      // Ошибка сессии 0001 наоборот: документ обещал код, которого сервер
      // не возвращает. Назначение ролей отвечает 200, и так же должно быть описано.
      const roles = document.paths['/api/v1/admin/users/{id}/roles'];
      expect(Object.keys(roles?.post?.responses ?? {})).toContain('200');
      expect(Object.keys(roles?.post?.responses ?? {})).not.toContain('201');
      expect(Object.keys(document.paths['/api/v1/positions']?.post?.responses ?? {})).toContain(
        '201',
      );
    });
  });
});
