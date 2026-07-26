import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountType, EmployeeStatus, GroupMentorRole } from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { GroupMentorsModule } from 'src/group-mentors/group-mentors.module';
import { GroupMentorsRepository } from 'src/group-mentors/group-mentors.repository';
import type {
  GroupMentorListParams,
  GroupMentorRow,
  GroupMentorWriteInput,
  MentorCandidate,
} from 'src/group-mentors/group-mentors.repository';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { PhoneModule } from 'src/phone/phone.module';
import { RbacModule } from 'src/rbac/rbac.module';
import { RbacRepository } from 'src/rbac/rbac.repository';
import { buildOpenApiDocument } from 'src/swagger';

/** `{ data }` ответа с ожидаемым типом — тела supertest типизированы как `any`. */
const dataOf = <T>(response: { body: unknown }): T => (response.body as { data: T }).data;

/** Права аккаунта в памяти вместо трёх таблиц RBAC (как в `catalog.e2e-spec.ts`). */
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

type StoredEmployee = GroupMentorRow['employee'];

/**
 * Менторы в памяти. Группы, сотрудники и назначения держатся вместе, потому что
 * связаны правилами модуля: назначение адресуется парой «группа + сотрудник»,
 * а профиль отдаётся вместе со списком. Несогласованные заглушки проверяли бы
 * не то поведение, которое даёт БД.
 */
class InMemoryMentorsStore {
  readonly groups = new Map<string, { id: string; name: string }>();
  readonly employees = new Map<string, StoredEmployee>();

  /** Ключ — `groupId:employeeId`, как составной первичный ключ в БД. */
  private readonly assignments = new Map<string, GroupMentorRow>();

  private assignedAtCounter = 0;

  addGroup(name: string): { id: string; name: string } {
    const group = { id: randomUUID(), name };
    this.groups.set(group.id, group);

    return group;
  }

  addEmployee(overrides: Partial<StoredEmployee> = {}): StoredEmployee {
    const employee: StoredEmployee = {
      id: randomUUID(),
      firstName: 'Фаррух',
      lastName: `Раҳимов-${String(this.employees.size + 1)}`,
      middleName: null,
      phone: `+99290123456${String(this.employees.size)}`,
      photoUrl: null,
      status: EmployeeStatus.ACTIVE,
      ...overrides,
    };
    this.employees.set(employee.id, employee);

    return employee;
  }

  // ─── GroupMentorsRepository ───

  findMany(params: GroupMentorListParams): Promise<{ rows: GroupMentorRow[]; total: number }> {
    const search = params.search?.toLowerCase();
    const matched = [...this.assignments.values()]
      .filter((mentor) => mentor.groupId === params.groupId)
      .filter((mentor) => params.role === undefined || mentor.role === params.role)
      .filter(
        (mentor) =>
          search === undefined ||
          [mentor.employee.firstName, mentor.employee.lastName, mentor.employee.phone].some(
            (field) => field.toLowerCase().includes(search),
          ),
      );

    const sort: string = params.sort;
    const order: string = params.order;

    matched.sort((a, b) => {
      const asc =
        sort === 'assignedAt'
          ? a.assignedAt.getTime() - b.assignedAt.getTime()
          : a.employee.lastName.localeCompare(b.employee.lastName) ||
            a.employee.firstName.localeCompare(b.employee.firstName);

      return order === 'asc' ? asc : -asc;
    });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findGroup(id: string): Promise<{ id: string; name: string } | null> {
    return Promise.resolve(this.groups.get(id) ?? null);
  }

  findEmployee(id: string): Promise<MentorCandidate | null> {
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

  findOne(groupId: string, employeeId: string): Promise<GroupMentorRow | null> {
    return Promise.resolve(this.assignments.get(key(groupId, employeeId)) ?? null);
  }

  create(input: GroupMentorWriteInput): Promise<GroupMentorRow> {
    const employee = this.employees.get(input.employeeId);
    if (!employee) throw new Error('Сотрудника нет: тест построен неверно');

    const mentor: GroupMentorRow = {
      groupId: input.groupId,
      employeeId: input.employeeId,
      // Умолчание колонки в БД: без роли в теле назначение становится Teaching.
      role: input.role ?? GroupMentorRole.TEACHING,
      assignedAt: new Date(Date.UTC(2026, 6, 27, 10, this.assignedAtCounter++)),
      employee,
    };
    this.assignments.set(key(mentor.groupId, mentor.employeeId), mentor);

    return Promise.resolve(mentor);
  }

  updateRole(groupId: string, employeeId: string, role: GroupMentorRole): Promise<GroupMentorRow> {
    const mentor = this.assignments.get(key(groupId, employeeId));
    if (!mentor) throw new Error('Назначения нет: тест построен неверно');

    mentor.role = role;

    return Promise.resolve(mentor);
  }

  /** Возвращает число очищенных слотов расписания — в этом наборе их нет. */
  delete(groupId: string, employeeId: string): Promise<number> {
    this.assignments.delete(key(groupId, employeeId));

    return Promise.resolve(0);
  }
}

const key = (groupId: string, employeeId: string): string => `${groupId}:${employeeId}`;

interface MentorBody {
  groupId: string;
  employee: {
    id: string;
    firstName: string;
    lastName: string;
    middleName: string | null;
    phone: string;
    photoUrl: string | null;
    status: EmployeeStatus;
  };
  role: GroupMentorRole;
  assignedAt: string;
}

describe('Менторы группы (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryMentorsStore;
  let rbac: InMemoryRbacRepository;
  let tokens: TokenService;

  /** Токен сотрудника с перечисленными правами. */
  const actor = async (...codes: string[]): Promise<string> => {
    const accountId = randomUUID();
    rbac.grant(accountId, codes);

    return (
      await tokens.issuePair({ sub: accountId, sid: randomUUID(), type: AccountType.EMPLOYEE })
    ).accessToken;
  };

  const studentToken = async (): Promise<string> =>
    (await tokens.issuePair({ sub: randomUUID(), sid: randomUUID(), type: AccountType.STUDENT }))
      .accessToken;

  beforeEach(async () => {
    store = new InMemoryMentorsStore();
    rbac = new InMemoryRbacRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        PhoneModule,
        // AuthModule нужен целиком: он приносит глобальный `JwtAuthGuard`.
        AuthModule,
        RbacModule,
        GroupMentorsModule,
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
      .overrideProvider(GroupMentorsRepository)
      .useValue({
        findMany: (params: GroupMentorListParams) => store.findMany(params),
        findGroup: (id: string) => store.findGroup(id),
        findEmployee: (id: string) => store.findEmployee(id),
        findOne: (groupId: string, employeeId: string) => store.findOne(groupId, employeeId),
        create: (input: GroupMentorWriteInput) => store.create(input),
        updateRole: (groupId: string, employeeId: string, role: GroupMentorRole) =>
          store.updateRole(groupId, employeeId, role),
        delete: (groupId: string, employeeId: string) => store.delete(groupId, employeeId),
      })
      .compile();

    tokens = moduleRef.get(TokenService, { strict: false });

    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
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
    body: Record<string, unknown> = {},
  ) => request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`).send(body);

  /** Группа, соседняя группа и два сотрудника — общая сцена большинства случаев. */
  const scene = () => {
    const group = store.addGroup('Frontend-1');
    const otherGroup = store.addGroup('Python-1');
    const teacher = store.addEmployee({ firstName: 'Фаррух', lastName: 'Раҳимов' });
    const assistant = store.addEmployee({ firstName: 'Нигина', lastName: 'Каримова' });

    return { group, otherGroup, teacher, assistant };
  };

  describe('Доступ', () => {
    it('без токена — 401', async () => {
      const { group } = scene();

      await request(app.getHttpServer()).get(`/api/v1/groups/${group.id}/mentors`).expect(401);
    });

    it('студент менторов группы не ведёт — 403 (ТЗ 3.2)', async () => {
      const { group } = scene();

      await get(`/api/v1/groups/${group.id}/mentors`, await studentToken()).expect(403);
    });

    it('сотрудник без прав — 403', async () => {
      const { group } = scene();

      const response = await get(`/api/v1/groups/${group.id}/mentors`, await actor()).expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('право на просмотр групп открывает список менторов, но не назначение', async () => {
      const { group, teacher } = scene();
      const token = await actor('Permission.Groups.Views');

      await get(`/api/v1/groups/${group.id}/mentors`, token).expect(200);
      await send('post', `/api/v1/groups/${group.id}/mentors`, token, {
        employeeId: teacher.id,
      }).expect(403);
    });

    it('право на правку группы не даёт назначать менторов — у них своё право', async () => {
      const { group, teacher } = scene();

      await send(
        'post',
        `/api/v1/groups/${group.id}/mentors`,
        await actor('Permission.Groups.Update'),
        { employeeId: teacher.id },
      ).expect(403);
    });

    it('снятие ментора требует того же права, что назначение', async () => {
      const { group, teacher } = scene();
      const manager = await actor('Permission.Groups.ManageMentors');

      await send('post', `/api/v1/groups/${group.id}/mentors`, manager, {
        employeeId: teacher.id,
      }).expect(201);

      await send(
        'delete',
        `/api/v1/groups/${group.id}/mentors/${teacher.id}`,
        await actor('Permission.Groups.Views'),
      ).expect(403);
    });
  });

  describe('Назначение ментора (ТЗ 5.5)', () => {
    it('назначает сотрудника и отдаёт его профиль; роль по умолчанию — Teaching', async () => {
      const { group, teacher } = scene();

      const response = await send(
        'post',
        `/api/v1/groups/${group.id}/mentors`,
        await actor('Permission.Groups.ManageMentors'),
        { employeeId: teacher.id },
      ).expect(201);

      expect(dataOf<MentorBody>(response)).toMatchObject({
        groupId: group.id,
        role: GroupMentorRole.TEACHING,
        employee: { id: teacher.id, lastName: 'Раҳимов', status: EmployeeStatus.ACTIVE },
      });
    });

    it('у группы несколько менторов с разными ролями (ТЗ 5.5)', async () => {
      const { group, teacher, assistant } = scene();
      const token = await actor('Permission.Groups.ManageMentors', 'Permission.Groups.Views');

      await send('post', `/api/v1/groups/${group.id}/mentors`, token, {
        employeeId: teacher.id,
        role: GroupMentorRole.TEACHING,
      }).expect(201);
      await send('post', `/api/v1/groups/${group.id}/mentors`, token, {
        employeeId: assistant.id,
        role: GroupMentorRole.SUPPORT,
      }).expect(201);

      const response = await get(`/api/v1/groups/${group.id}/mentors`, token).expect(200);
      const body = response.body as { data: MentorBody[]; meta: { total: number } };

      expect(body.meta.total).toBe(2);
      // Порядок по умолчанию — по фамилии: Каримова раньше Раҳимова.
      expect(body.data.map((mentor) => mentor.employee.lastName)).toEqual(['Каримова', 'Раҳимов']);
      expect(body.data.map((mentor) => mentor.role)).toEqual([
        GroupMentorRole.SUPPORT,
        GroupMentorRole.TEACHING,
      ]);
    });

    it('позиция «Mentor» не требуется: сотрудник без единой позиции назначается', async () => {
      const { group } = scene();
      // У сотрудника в хранилище нет ни одной позиции — правило про «Mentor»
      // отменено решением сессии 0010, и назначение проходит.
      const director = store.addEmployee({ firstName: 'Дилшод', lastName: 'Ҳакимов' });

      await send(
        'post',
        `/api/v1/groups/${group.id}/mentors`,
        await actor('Permission.Groups.ManageMentors'),
        { employeeId: director.id },
      ).expect(201);
    });

    it('несуществующий сотрудник — 422 (пришёл в теле, а не в пути)', async () => {
      const { group } = scene();

      const response = await send(
        'post',
        `/api/v1/groups/${group.id}/mentors`,
        await actor('Permission.Groups.ManageMentors'),
        { employeeId: randomUUID() },
      ).expect(422);

      expect(response.body.error.code).toBe('UNPROCESSABLE_ENTITY');
    });

    it('выведенного из штата сотрудника ментором не назначить — 422', async () => {
      const { group } = scene();
      const fired = store.addEmployee({ status: EmployeeStatus.INACTIVE });

      const response = await send(
        'post',
        `/api/v1/groups/${group.id}/mentors`,
        await actor('Permission.Groups.ManageMentors'),
        { employeeId: fired.id },
      ).expect(422);

      expect(response.body.error.message).toContain('выведен из штата');
    });

    it('повторное назначение того же сотрудника — 409', async () => {
      const { group, teacher } = scene();
      const token = await actor('Permission.Groups.ManageMentors');

      await send('post', `/api/v1/groups/${group.id}/mentors`, token, {
        employeeId: teacher.id,
      }).expect(201);

      const response = await send('post', `/api/v1/groups/${group.id}/mentors`, token, {
        employeeId: teacher.id,
        role: GroupMentorRole.SUPPORT,
      }).expect(409);

      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('тот же сотрудник ведёт вторую группу — это не конфликт', async () => {
      const { group, otherGroup, teacher } = scene();
      const token = await actor('Permission.Groups.ManageMentors');

      await send('post', `/api/v1/groups/${group.id}/mentors`, token, {
        employeeId: teacher.id,
      }).expect(201);
      await send('post', `/api/v1/groups/${otherGroup.id}/mentors`, token, {
        employeeId: teacher.id,
      }).expect(201);
    });

    it('неизвестная группа — 404', async () => {
      const { teacher } = scene();

      await send(
        'post',
        `/api/v1/groups/${randomUUID()}/mentors`,
        await actor('Permission.Groups.ManageMentors'),
        { employeeId: teacher.id },
      ).expect(404);
    });

    it('не-UUID в пути и в теле — 400', async () => {
      const { group, teacher } = scene();
      const token = await actor('Permission.Groups.ManageMentors');

      await send('post', `/api/v1/groups/не-uuid/mentors`, token, {
        employeeId: teacher.id,
      }).expect(400);
      await send('post', `/api/v1/groups/${group.id}/mentors`, token, {
        employeeId: 'не-uuid',
      }).expect(400);
    });

    it('неизвестная роль и лишнее поле — 400', async () => {
      const { group, teacher } = scene();
      const token = await actor('Permission.Groups.ManageMentors');

      await send('post', `/api/v1/groups/${group.id}/mentors`, token, {
        employeeId: teacher.id,
        role: 'HEAD_TEACHER',
      }).expect(400);
      await send('post', `/api/v1/groups/${group.id}/mentors`, token, {
        employeeId: teacher.id,
        salary: 5000,
      }).expect(400);
    });
  });

  describe('Список менторов', () => {
    it('отдаёт { data, meta } и фильтрует по роли', async () => {
      const { group, teacher, assistant } = scene();
      const token = await actor('Permission.Groups.ManageMentors', 'Permission.Groups.Views');

      await send('post', `/api/v1/groups/${group.id}/mentors`, token, {
        employeeId: teacher.id,
        role: GroupMentorRole.TEACHING,
      }).expect(201);
      await send('post', `/api/v1/groups/${group.id}/mentors`, token, {
        employeeId: assistant.id,
        role: GroupMentorRole.SUPPORT,
      }).expect(201);

      const response = await get(
        `/api/v1/groups/${group.id}/mentors?role=${GroupMentorRole.SUPPORT}`,
        token,
      ).expect(200);
      const body = response.body as { data: MentorBody[]; meta: { total: number; limit: number } };

      expect(body.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(body.data).toHaveLength(1);
      expect(body.data[0].employee.id).toBe(assistant.id);
    });

    it('ищет по фамилии сотрудника', async () => {
      const { group, teacher, assistant } = scene();
      const token = await actor('Permission.Groups.ManageMentors', 'Permission.Groups.Views');

      for (const employeeId of [teacher.id, assistant.id]) {
        await send('post', `/api/v1/groups/${group.id}/mentors`, token, { employeeId }).expect(201);
      }

      const response = await get(
        `/api/v1/groups/${group.id}/mentors?search=каримова`,
        token,
      ).expect(200);
      const body = response.body as { data: MentorBody[] };

      expect(body.data).toHaveLength(1);
      expect(body.data[0].employee.id).toBe(assistant.id);
    });

    it('менторы соседней группы в список не попадают', async () => {
      const { group, otherGroup, teacher, assistant } = scene();
      const token = await actor('Permission.Groups.ManageMentors', 'Permission.Groups.Views');

      await send('post', `/api/v1/groups/${group.id}/mentors`, token, {
        employeeId: teacher.id,
      }).expect(201);
      await send('post', `/api/v1/groups/${otherGroup.id}/mentors`, token, {
        employeeId: assistant.id,
      }).expect(201);

      const response = await get(`/api/v1/groups/${group.id}/mentors`, token).expect(200);
      const body = response.body as { data: MentorBody[]; meta: { total: number } };

      expect(body.meta.total).toBe(1);
      expect(body.data[0].employee.id).toBe(teacher.id);
    });

    it('неизвестная группа — 404 и в списке', async () => {
      await get(
        `/api/v1/groups/${randomUUID()}/mentors`,
        await actor('Permission.Groups.Views'),
      ).expect(404);
    });
  });

  describe('Смена роли (ТЗ 5.5: Teaching ↔ Support)', () => {
    it('переводит ментора из Teaching в Support, не трогая назначение', async () => {
      const { group, teacher } = scene();
      const token = await actor('Permission.Groups.ManageMentors', 'Permission.Groups.Views');

      await send('post', `/api/v1/groups/${group.id}/mentors`, token, {
        employeeId: teacher.id,
      }).expect(201);

      const response = await send(
        'put',
        `/api/v1/groups/${group.id}/mentors/${teacher.id}`,
        token,
        { role: GroupMentorRole.SUPPORT },
      ).expect(200);

      expect(dataOf<MentorBody>(response).role).toBe(GroupMentorRole.SUPPORT);

      const list = await get(`/api/v1/groups/${group.id}/mentors`, token).expect(200);
      const body = list.body as { data: MentorBody[]; meta: { total: number } };

      expect(body.meta.total).toBe(1);
      expect(body.data[0].role).toBe(GroupMentorRole.SUPPORT);
    });

    it('не назначенный сотрудник — 404', async () => {
      const { group, teacher } = scene();

      await send(
        'put',
        `/api/v1/groups/${group.id}/mentors/${teacher.id}`,
        await actor('Permission.Groups.ManageMentors'),
        { role: GroupMentorRole.SUPPORT },
      ).expect(404);
    });

    it('ментор соседней группы по этому адресу не найдётся — 404', async () => {
      const { group, otherGroup, teacher } = scene();
      const token = await actor('Permission.Groups.ManageMentors');

      await send('post', `/api/v1/groups/${otherGroup.id}/mentors`, token, {
        employeeId: teacher.id,
      }).expect(201);

      await send('put', `/api/v1/groups/${group.id}/mentors/${teacher.id}`, token, {
        role: GroupMentorRole.SUPPORT,
      }).expect(404);
    });

    it('тело без роли — 400', async () => {
      const { group, teacher } = scene();
      const token = await actor('Permission.Groups.ManageMentors');

      await send('post', `/api/v1/groups/${group.id}/mentors`, token, {
        employeeId: teacher.id,
      }).expect(201);

      await send('put', `/api/v1/groups/${group.id}/mentors/${teacher.id}`, token, {}).expect(400);
    });
  });

  describe('Снятие ментора', () => {
    it('снимает назначение, называет снятого и оставляет группу без менторов', async () => {
      const { group, teacher } = scene();
      const token = await actor('Permission.Groups.ManageMentors', 'Permission.Groups.Views');

      await send('post', `/api/v1/groups/${group.id}/mentors`, token, {
        employeeId: teacher.id,
      }).expect(201);

      const response = await send(
        'delete',
        `/api/v1/groups/${group.id}/mentors/${teacher.id}`,
        token,
      ).expect(200);

      expect(dataOf<{ fullName: string; employeeId: string }>(response)).toEqual({
        groupId: group.id,
        employeeId: teacher.id,
        fullName: 'Раҳимов Фаррух',
        // Занятий у группы в этом наборе нет. Сама очистка слотов живёт
        // в транзакции репозитория, а он здесь подменён — проверить её
        // можно только на настоящей БД.
        clearedSlots: 0,
      });

      const list = await get(`/api/v1/groups/${group.id}/mentors`, token).expect(200);

      expect((list.body as { meta: { total: number } }).meta.total).toBe(0);
    });

    it('повторное снятие — 404', async () => {
      const { group, teacher } = scene();
      const token = await actor('Permission.Groups.ManageMentors');

      await send('post', `/api/v1/groups/${group.id}/mentors`, token, {
        employeeId: teacher.id,
      }).expect(201);
      await send('delete', `/api/v1/groups/${group.id}/mentors/${teacher.id}`, token).expect(200);
      await send('delete', `/api/v1/groups/${group.id}/mentors/${teacher.id}`, token).expect(404);
    });

    it('снятие ментора одной группы не трогает его назначение в другой', async () => {
      const { group, otherGroup, teacher } = scene();
      const token = await actor('Permission.Groups.ManageMentors', 'Permission.Groups.Views');

      for (const id of [group.id, otherGroup.id]) {
        await send('post', `/api/v1/groups/${id}/mentors`, token, {
          employeeId: teacher.id,
        }).expect(201);
      }

      await send('delete', `/api/v1/groups/${group.id}/mentors/${teacher.id}`, token).expect(200);

      const list = await get(`/api/v1/groups/${otherGroup.id}/mentors`, token).expect(200);

      expect((list.body as { meta: { total: number } }).meta.total).toBe(1);
    });
  });

  describe('OpenAPI', () => {
    it('документ описывает маршруты менторов и код 201 на назначение', () => {
      // Документ собирается напрямую: маршрут `/docs/json` монтируется только
      // при `SWAGGER_ENABLED=true`, а в CI Swagger выключен (сессия 0006).
      const document = buildOpenApiDocument(app);

      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/groups/{groupId}/mentors',
          '/api/v1/groups/{groupId}/mentors/{employeeId}',
        ]),
      );

      expect(
        Object.keys(document.paths['/api/v1/groups/{groupId}/mentors']?.post?.responses ?? {}),
      ).toContain('201');
    });
  });
});
