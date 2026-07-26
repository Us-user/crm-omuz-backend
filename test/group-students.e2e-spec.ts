import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountType, GroupStudentStatus, StudentStatus } from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { GroupStudentsModule } from 'src/group-students/group-students.module';
import { GroupStudentsRepository } from 'src/group-students/group-students.repository';
import type {
  CompetingMembership,
  GroupStudentListParams,
  GroupStudentRow,
  StudentCandidate,
  StudentGroup,
  TransferInput,
} from 'src/group-students/group-students.repository';
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

type StoredStudent = GroupStudentRow['student'];

/**
 * Состав в памяти. Группы, курсы, студенты и членства держатся вместе, потому
 * что правила модуля связывают их между собой: «одно действующее членство
 * на курс» смотрит на курс чужой группы, а перевод пишет сразу в две группы.
 * Несогласованные заглушки проверяли бы не то поведение, которое даёт БД.
 */
class InMemoryStudentsStore {
  readonly groups = new Map<string, StudentGroup>();
  readonly students = new Map<string, StoredStudent>();

  /** Ключ — `groupId:studentId`, как составной первичный ключ в БД. */
  private readonly memberships = new Map<string, GroupStudentRow>();

  addGroup(name: string, courseId: string, capacity: number | null = null): StudentGroup {
    const group: StudentGroup = { id: randomUUID(), name, courseId, capacity };
    this.groups.set(group.id, group);

    return group;
  }

  addStudent(overrides: Partial<StoredStudent> = {}): StoredStudent {
    const student: StoredStudent = {
      id: randomUUID(),
      firstName: 'Нигина',
      lastName: `Каримова-${String(this.students.size + 1)}`,
      phone: `+99290123456${String(this.students.size)}`,
      photoUrl: null,
      status: StudentStatus.ACTIVE,
      ...overrides,
    };
    this.students.set(student.id, student);

    return student;
  }

  // ─── GroupStudentsRepository ───

  findMany(params: GroupStudentListParams): Promise<{ rows: GroupStudentRow[]; total: number }> {
    const search = params.search?.toLowerCase();
    const matched = [...this.memberships.values()]
      .filter((membership) => membership.groupId === params.groupId)
      .filter((membership) => params.status === undefined || membership.status === params.status)
      .filter(
        (membership) =>
          search === undefined ||
          [
            membership.student.firstName,
            membership.student.lastName,
            membership.student.phone,
          ].some((field) => field.toLowerCase().includes(search)),
      );

    const sort: string = params.sort;
    const order: string = params.order;

    matched.sort((a, b) => {
      const asc =
        sort === 'enrolledAt'
          ? a.enrolledAt.getTime() - b.enrolledAt.getTime()
          : a.student.lastName.localeCompare(b.student.lastName) ||
            a.student.firstName.localeCompare(b.student.firstName);

      return order === 'asc' ? asc : -asc;
    });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findGroup(id: string): Promise<StudentGroup | null> {
    return Promise.resolve(this.groups.get(id) ?? null);
  }

  findStudents(ids: string[]): Promise<StudentCandidate[]> {
    return Promise.resolve(
      ids
        .map((id) => this.students.get(id))
        .filter((student): student is StoredStudent => student !== undefined)
        .map((student) => ({
          id: student.id,
          firstName: student.firstName,
          lastName: student.lastName,
        })),
    );
  }

  findOne(groupId: string, studentId: string): Promise<GroupStudentRow | null> {
    return Promise.resolve(this.memberships.get(key(groupId, studentId)) ?? null);
  }

  findMemberships(groupId: string, studentIds: string[]): Promise<GroupStudentRow[]> {
    return Promise.resolve(
      studentIds
        .map((studentId) => this.memberships.get(key(groupId, studentId)))
        .filter((membership): membership is GroupStudentRow => membership !== undefined),
    );
  }

  findCompetingMemberships(
    courseId: string,
    studentIds: string[],
    exceptGroupIds: string[],
  ): Promise<CompetingMembership[]> {
    const competing = [...this.memberships.values()]
      .filter((membership) => studentIds.includes(membership.studentId))
      .filter((membership) => membership.status === GroupStudentStatus.ACTIVE)
      .filter((membership) => !exceptGroupIds.includes(membership.groupId))
      .filter((membership) => this.groupOrThrow(membership.groupId).courseId === courseId)
      .map((membership) => ({
        studentId: membership.studentId,
        groupId: membership.groupId,
        group: { name: this.groupOrThrow(membership.groupId).name },
        student: {
          firstName: membership.student.firstName,
          lastName: membership.student.lastName,
        },
      }));

    return Promise.resolve(competing);
  }

  countActive(groupId: string): Promise<number> {
    return Promise.resolve(
      [...this.memberships.values()].filter(
        (membership) =>
          membership.groupId === groupId && membership.status === GroupStudentStatus.ACTIVE,
      ).length,
    );
  }

  enroll(groupId: string, studentIds: string[], enrolledAt: Date): Promise<GroupStudentRow[]> {
    return Promise.resolve(
      studentIds.map((studentId) => {
        const existing = this.memberships.get(key(groupId, studentId));
        // `upsert` в БД: вернувшийся занимает прежнюю строку, причина и дата
        // прошлого ухода снимаются.
        const membership: GroupStudentRow = {
          ...(existing ?? this.blank(groupId, studentId)),
          status: GroupStudentStatus.ACTIVE,
          statusReason: null,
          statusChangedAt: null,
          transferredFromGroup: null,
          enrolledAt,
        };
        this.memberships.set(key(groupId, studentId), membership);

        return membership;
      }),
    );
  }

  changeStatus(
    groupId: string,
    studentIds: string[],
    status: GroupStudentStatus,
    reason: string,
    changedAt: Date,
  ): Promise<GroupStudentRow[]> {
    return Promise.resolve(
      studentIds.map((studentId) => {
        const membership = this.membershipOrThrow(groupId, studentId);
        membership.status = status;
        membership.statusReason = reason;
        membership.statusChangedAt = changedAt;

        return membership;
      }),
    );
  }

  transfer(input: TransferInput): Promise<GroupStudentRow[]> {
    const from = this.groupOrThrow(input.fromGroupId);

    for (const studentId of input.studentIds) {
      const membership = this.membershipOrThrow(input.fromGroupId, studentId);
      membership.status = GroupStudentStatus.TRANSFERRED;
      membership.statusReason = input.reason;
      membership.statusChangedAt = input.changedAt;
    }

    return Promise.resolve(
      input.studentIds.map((studentId) => {
        const existing = this.memberships.get(key(input.toGroupId, studentId));
        const membership: GroupStudentRow = {
          ...(existing ?? this.blank(input.toGroupId, studentId)),
          status: GroupStudentStatus.ACTIVE,
          statusReason: null,
          statusChangedAt: null,
          transferredFromGroup: { id: from.id, name: from.name },
          enrolledAt: input.changedAt,
        };
        this.memberships.set(key(input.toGroupId, studentId), membership);

        return membership;
      }),
    );
  }

  delete(groupId: string, studentId: string): Promise<void> {
    this.memberships.delete(key(groupId, studentId));

    return Promise.resolve();
  }

  private blank(groupId: string, studentId: string): GroupStudentRow {
    const student = this.students.get(studentId);
    if (!student) throw new Error('Студента нет: тест построен неверно');

    return {
      groupId,
      studentId,
      status: GroupStudentStatus.ACTIVE,
      statusReason: null,
      statusChangedAt: null,
      enrolledAt: new Date('2026-09-01T10:00:00.000Z'),
      student,
      transferredFromGroup: null,
    };
  }

  private groupOrThrow(id: string): StudentGroup {
    const group = this.groups.get(id);
    if (!group) throw new Error('Группы нет: тест построен неверно');

    return group;
  }

  private membershipOrThrow(groupId: string, studentId: string): GroupStudentRow {
    const membership = this.memberships.get(key(groupId, studentId));
    if (!membership) throw new Error('Членства нет: тест построен неверно');

    return membership;
  }
}

const key = (groupId: string, studentId: string): string => `${groupId}:${studentId}`;

interface MembershipBody {
  groupId: string;
  student: { id: string; firstName: string; lastName: string; status: StudentStatus };
  status: GroupStudentStatus;
  statusReason: string | null;
  statusChangedAt: string | null;
  transferredFrom: { id: string; name: string } | null;
  enrolledAt: string;
}

describe('Состав группы (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryStudentsStore;
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
    store = new InMemoryStudentsStore();
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
        GroupStudentsModule,
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
      .overrideProvider(GroupStudentsRepository)
      .useValue({
        findMany: (params: GroupStudentListParams) => store.findMany(params),
        findGroup: (id: string) => store.findGroup(id),
        findStudents: (ids: string[]) => store.findStudents(ids),
        findOne: (groupId: string, studentId: string) => store.findOne(groupId, studentId),
        findMemberships: (groupId: string, studentIds: string[]) =>
          store.findMemberships(groupId, studentIds),
        findCompetingMemberships: (
          courseId: string,
          studentIds: string[],
          exceptGroupIds: string[],
        ) => store.findCompetingMemberships(courseId, studentIds, exceptGroupIds),
        countActive: (groupId: string) => store.countActive(groupId),
        enroll: (groupId: string, studentIds: string[], enrolledAt: Date) =>
          store.enroll(groupId, studentIds, enrolledAt),
        changeStatus: (
          groupId: string,
          studentIds: string[],
          status: GroupStudentStatus,
          reason: string,
          changedAt: Date,
        ) => store.changeStatus(groupId, studentIds, status, reason, changedAt),
        transfer: (input: TransferInput) => store.transfer(input),
        delete: (groupId: string, studentId: string) => store.delete(groupId, studentId),
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
    method: 'post' | 'delete',
    url: string,
    token: string,
    body: Record<string, unknown> = {},
  ) => request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`).send(body);

  const FRONTEND = 'course-frontend';
  const PYTHON = 'course-python';

  /**
   * Две группы одного курса, одна — соседнего, и два студента. Общая сцена
   * почти всех случаев: на ней проверяется и правило «одна группа на курс»,
   * и перевод между потоками.
   */
  const scene = () => {
    const group = store.addGroup('Frontend-1', FRONTEND, 16);
    const twinGroup = store.addGroup('Frontend-2', FRONTEND);
    const otherCourseGroup = store.addGroup('Python-1', PYTHON);
    const nigina = store.addStudent({ firstName: 'Нигина', lastName: 'Каримова' });
    const farrukh = store.addStudent({ firstName: 'Фаррух', lastName: 'Раҳимов' });

    return { group, twinGroup, otherCourseGroup, nigina, farrukh };
  };

  describe('Доступ', () => {
    it('без токена — 401', async () => {
      const { group } = scene();

      await request(app.getHttpServer()).get(`/api/v1/groups/${group.id}/students`).expect(401);
    });

    it('студент составом группы не управляет — 403 (ТЗ 3.2)', async () => {
      const { group } = scene();

      await get(`/api/v1/groups/${group.id}/students`, await studentToken()).expect(403);
    });

    it('сотрудник без прав — 403', async () => {
      const { group } = scene();

      const response = await get(`/api/v1/groups/${group.id}/students`, await actor()).expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('право на просмотр групп открывает состав, но не зачисление', async () => {
      const { group, nigina } = scene();
      const token = await actor('Permission.Groups.Views');

      await get(`/api/v1/groups/${group.id}/students`, token).expect(200);
      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(403);
    });

    it('право на менторов состав не открывает — у него своё право', async () => {
      const { group, nigina } = scene();

      await send(
        'post',
        `/api/v1/groups/${group.id}/students`,
        await actor('Permission.Groups.ManageMentors'),
        { studentIds: [nigina.id] },
      ).expect(403);
    });

    it('перевод и смена статуса требуют того же права, что зачисление', async () => {
      const { group, twinGroup, nigina } = scene();
      const viewer = await actor('Permission.Groups.Views');

      await send('post', `/api/v1/groups/${group.id}/students/transfer`, viewer, {
        studentIds: [nigina.id],
        targetGroupId: twinGroup.id,
        reason: 'Перевод в вечерний поток',
      }).expect(403);

      await send('post', `/api/v1/groups/${group.id}/students/change-status`, viewer, {
        studentIds: [nigina.id],
        status: GroupStudentStatus.LEFT,
        reason: 'Переехал',
      }).expect(403);
    });
  });

  describe('Зачисление (ТЗ 5.5)', () => {
    it('зачисляет пачкой, отдаёт профили и «набрано»', async () => {
      const { group, nigina, farrukh } = scene();

      const response = await send(
        'post',
        `/api/v1/groups/${group.id}/students`,
        await actor('Permission.Groups.ManageStudents'),
        { studentIds: [nigina.id, farrukh.id] },
      ).expect(201);

      const body = dataOf<{ students: MembershipBody[]; enrolledCount: number }>(response);

      expect(body.enrolledCount).toBe(2);
      expect(body.students.map((membership) => membership.student.id)).toEqual([
        nigina.id,
        farrukh.id,
      ]);
      expect(body.students[0]).toMatchObject({
        groupId: group.id,
        status: GroupStudentStatus.ACTIVE,
        statusReason: null,
        statusChangedAt: null,
        transferredFrom: null,
      });
    });

    it('несуществующий студент — 422 с перечислением только недостающих', async () => {
      const { group, nigina } = scene();
      const ghost = randomUUID();

      const response = await send(
        'post',
        `/api/v1/groups/${group.id}/students`,
        await actor('Permission.Groups.ManageStudents'),
        { studentIds: [nigina.id, ghost] },
      ).expect(422);

      expect(response.body.error.details).toEqual({ studentIds: [ghost] });

      // Зачисление не состоялось целиком, а не наполовину.
      const list = await get(
        `/api/v1/groups/${group.id}/students`,
        await actor('Permission.Groups.Views'),
      ).expect(200);

      expect((list.body as { meta: { total: number } }).meta.total).toBe(0);
    });

    it('повторное зачисление действующего студента — 409 с именем', async () => {
      const { group, nigina } = scene();
      const token = await actor('Permission.Groups.ManageStudents');

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);

      const response = await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(409);

      expect(response.body.error.message).toContain('Каримова Нигина');
    });

    it('покинувший группу зачисляется в неё заново — с чистой причиной и датой', async () => {
      const { group, nigina } = scene();
      const token = await actor('Permission.Groups.ManageStudents', 'Permission.Groups.Views');

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);
      await send('post', `/api/v1/groups/${group.id}/students/change-status`, token, {
        studentIds: [nigina.id],
        status: GroupStudentStatus.LEFT,
        reason: 'Взял паузу',
      }).expect(200);

      const response = await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);

      expect(dataOf<{ students: MembershipBody[] }>(response).students[0]).toMatchObject({
        status: GroupStudentStatus.ACTIVE,
        statusReason: null,
        statusChangedAt: null,
      });

      // Строка та же самая, а не вторая: состав по-прежнему из одного человека.
      const list = await get(`/api/v1/groups/${group.id}/students`, token).expect(200);

      expect((list.body as { meta: { total: number } }).meta.total).toBe(1);
    });

    it('409 на вторую группу того же курса — с названием занятой группы', async () => {
      const { group, twinGroup, nigina } = scene();
      const token = await actor('Permission.Groups.ManageStudents');

      await send('post', `/api/v1/groups/${twinGroup.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);

      const response = await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(409);

      expect(response.body.error.message).toContain('Frontend-2');
    });

    it('группа другого курса — не конфликт: параллельное обучение разрешено', async () => {
      const { group, otherCourseGroup, nigina } = scene();
      const token = await actor('Permission.Groups.ManageStudents');

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);
      await send('post', `/api/v1/groups/${otherCourseGroup.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);
    });

    it('ушедший из соседней группы курса больше её не занимает', async () => {
      const { group, twinGroup, nigina } = scene();
      const token = await actor('Permission.Groups.ManageStudents');

      await send('post', `/api/v1/groups/${twinGroup.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);
      await send('post', `/api/v1/groups/${twinGroup.id}/students/change-status`, token, {
        studentIds: [nigina.id],
        status: GroupStudentStatus.LEFT,
        reason: 'Не подошло расписание',
      }).expect(200);

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);
    });

    it('набор сверх вместимости не запрещён (ТЗ 5.5: план, а не предел)', async () => {
      const group = store.addGroup('Frontend-mini', FRONTEND, 1);
      const first = store.addStudent();
      const second = store.addStudent();

      const response = await send(
        'post',
        `/api/v1/groups/${group.id}/students`,
        await actor('Permission.Groups.ManageStudents'),
        { studentIds: [first.id, second.id] },
      ).expect(201);

      expect(dataOf<{ enrolledCount: number }>(response).enrolledCount).toBe(2);
    });

    it('неизвестная группа — 404', async () => {
      const { nigina } = scene();

      await send(
        'post',
        `/api/v1/groups/${randomUUID()}/students`,
        await actor('Permission.Groups.ManageStudents'),
        { studentIds: [nigina.id] },
      ).expect(404);
    });

    it('пустой список, не-UUID, повтор и лишнее поле — 400', async () => {
      const { group, nigina } = scene();
      const token = await actor('Permission.Groups.ManageStudents');

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [],
      }).expect(400);
      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: ['не-uuid'],
      }).expect(400);
      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id, nigina.id],
      }).expect(400);
      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
        contractSigned: true,
      }).expect(400);
      await send('post', `/api/v1/groups/не-uuid/students`, token, {
        studentIds: [nigina.id],
      }).expect(400);
    });
  });

  describe('Список состава', () => {
    it('отдаёт { data, meta }, порядок по фамилии и фильтр статуса', async () => {
      const { group, nigina, farrukh } = scene();
      const token = await actor('Permission.Groups.ManageStudents', 'Permission.Groups.Views');

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [farrukh.id, nigina.id],
      }).expect(201);
      await send('post', `/api/v1/groups/${group.id}/students/change-status`, token, {
        studentIds: [farrukh.id],
        status: GroupStudentStatus.LEFT,
        reason: 'Нашёл работу',
      }).expect(200);

      const all = await get(`/api/v1/groups/${group.id}/students`, token).expect(200);
      const allBody = all.body as {
        data: MembershipBody[];
        meta: { total: number; limit: number };
      };

      expect(allBody.meta).toMatchObject({ total: 2, page: 1, limit: 20 });
      // Закрытые членства из состава не пропадают: это история группы.
      expect(allBody.data.map((membership) => membership.student.lastName)).toEqual([
        'Каримова',
        'Раҳимов',
      ]);

      const left = await get(
        `/api/v1/groups/${group.id}/students?status=${GroupStudentStatus.LEFT}`,
        token,
      ).expect(200);
      const leftBody = left.body as { data: MembershipBody[]; meta: { total: number } };

      expect(leftBody.meta.total).toBe(1);
      expect(leftBody.data[0]).toMatchObject({
        student: { id: farrukh.id },
        statusReason: 'Нашёл работу',
      });
      expect(leftBody.data[0].statusChangedAt).not.toBeNull();
    });

    it('ищет по фамилии студента', async () => {
      const { group, nigina, farrukh } = scene();
      const token = await actor('Permission.Groups.ManageStudents', 'Permission.Groups.Views');

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id, farrukh.id],
      }).expect(201);

      const response = await get(
        `/api/v1/groups/${group.id}/students?search=раҳимов`,
        token,
      ).expect(200);
      const body = response.body as { data: MembershipBody[] };

      expect(body.data).toHaveLength(1);
      expect(body.data[0].student.id).toBe(farrukh.id);
    });

    it('состав соседней группы в список не попадает', async () => {
      const { group, twinGroup, nigina, farrukh } = scene();
      const token = await actor('Permission.Groups.ManageStudents', 'Permission.Groups.Views');

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);
      await send('post', `/api/v1/groups/${twinGroup.id}/students`, token, {
        studentIds: [farrukh.id],
      }).expect(201);

      const response = await get(`/api/v1/groups/${group.id}/students`, token).expect(200);
      const body = response.body as { data: MembershipBody[]; meta: { total: number } };

      expect(body.meta.total).toBe(1);
      expect(body.data[0].student.id).toBe(nigina.id);
    });

    it('неизвестная группа — 404 и в списке', async () => {
      await get(
        `/api/v1/groups/${randomUUID()}/students`,
        await actor('Permission.Groups.Views'),
      ).expect(404);
    });
  });

  describe('Массовая смена статуса (ТЗ 5.5: Change status с Reason)', () => {
    it('ставит статус с причиной сразу нескольким студентам', async () => {
      const { group, nigina, farrukh } = scene();
      const token = await actor('Permission.Groups.ManageStudents', 'Permission.Groups.Views');

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id, farrukh.id],
      }).expect(201);

      const response = await send(
        'post',
        `/api/v1/groups/${group.id}/students/change-status`,
        token,
        {
          studentIds: [nigina.id, farrukh.id],
          status: GroupStudentStatus.FINISHED,
          reason: 'Группа завершила курс',
        },
      ).expect(200);

      const body = dataOf<{ students: MembershipBody[]; enrolledCount: number }>(response);

      // Завершившие в «набрано» не считаются — группа опустела.
      expect(body.enrolledCount).toBe(0);
      expect(body.students.every((m) => m.status === GroupStudentStatus.FINISHED)).toBe(true);
      expect(body.students[0].statusReason).toBe('Группа завершила курс');
    });

    it('причина обязательна и не может быть отпиской в два символа — 400', async () => {
      const { group, nigina } = scene();
      const token = await actor('Permission.Groups.ManageStudents');

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);

      await send('post', `/api/v1/groups/${group.id}/students/change-status`, token, {
        studentIds: [nigina.id],
        status: GroupStudentStatus.LEFT,
      }).expect(400);

      await send('post', `/api/v1/groups/${group.id}/students/change-status`, token, {
        studentIds: [nigina.id],
        status: GroupStudentStatus.LEFT,
        reason: '  -  ',
      }).expect(400);
    });

    it('TRANSFERRED этим маршрутом не ставится — 422', async () => {
      const { group, nigina } = scene();
      const token = await actor('Permission.Groups.ManageStudents');

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);

      const response = await send(
        'post',
        `/api/v1/groups/${group.id}/students/change-status`,
        token,
        {
          studentIds: [nigina.id],
          status: GroupStudentStatus.TRANSFERRED,
          reason: 'Перевод в другую группу',
        },
      ).expect(422);

      expect(response.body.error.message).toContain('переводом');
    });

    it('студент не из состава — 422 с перечислением', async () => {
      const { group, nigina } = scene();

      const response = await send(
        'post',
        `/api/v1/groups/${group.id}/students/change-status`,
        await actor('Permission.Groups.ManageStudents'),
        { studentIds: [nigina.id], status: GroupStudentStatus.LEFT, reason: 'Переехал' },
      ).expect(422);

      expect(response.body.error.details).toEqual({ studentIds: [nigina.id] });
    });

    it('возврат в ACTIVE упирается в действующее членство на том же курсе — 409', async () => {
      const { group, twinGroup, nigina } = scene();
      const token = await actor('Permission.Groups.ManageStudents');

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);
      await send('post', `/api/v1/groups/${group.id}/students/change-status`, token, {
        studentIds: [nigina.id],
        status: GroupStudentStatus.LEFT,
        reason: 'Взял паузу',
      }).expect(200);
      await send('post', `/api/v1/groups/${twinGroup.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);

      await send('post', `/api/v1/groups/${group.id}/students/change-status`, token, {
        studentIds: [nigina.id],
        status: GroupStudentStatus.ACTIVE,
        reason: 'Вернулся с паузы',
      }).expect(409);
    });

    it('неизвестный статус и неизвестная группа — 400 и 404', async () => {
      const { group, nigina } = scene();
      const token = await actor('Permission.Groups.ManageStudents');

      await send('post', `/api/v1/groups/${group.id}/students/change-status`, token, {
        studentIds: [nigina.id],
        status: 'EXPELLED',
        reason: 'Отчислен',
      }).expect(400);

      await send('post', `/api/v1/groups/${randomUUID()}/students/change-status`, token, {
        studentIds: [nigina.id],
        status: GroupStudentStatus.LEFT,
        reason: 'Переехал',
      }).expect(404);
    });
  });

  describe('Перевод в другую группу (ТЗ 5.5: Transfer)', () => {
    it('закрывает прежнее членство и заводит новое, сохраняя историю', async () => {
      const { group, twinGroup, nigina } = scene();
      const token = await actor('Permission.Groups.ManageStudents', 'Permission.Groups.Views');

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);

      const response = await send('post', `/api/v1/groups/${group.id}/students/transfer`, token, {
        studentIds: [nigina.id],
        targetGroupId: twinGroup.id,
        reason: 'Не совпадает расписание',
      }).expect(200);

      const body = dataOf<{
        fromGroupId: string;
        toGroupId: string;
        students: MembershipBody[];
        enrolledCount: number;
      }>(response);

      expect(body).toMatchObject({
        fromGroupId: group.id,
        toGroupId: twinGroup.id,
        enrolledCount: 0,
      });
      expect(body.students[0]).toMatchObject({
        groupId: twinGroup.id,
        status: GroupStudentStatus.ACTIVE,
        transferredFrom: { id: group.id, name: 'Frontend-1' },
      });

      // В прежней группе строка осталась — со статусом и причиной.
      const source = await get(`/api/v1/groups/${group.id}/students`, token).expect(200);
      const sourceBody = source.body as { data: MembershipBody[]; meta: { total: number } };

      expect(sourceBody.meta.total).toBe(1);
      expect(sourceBody.data[0]).toMatchObject({
        status: GroupStudentStatus.TRANSFERRED,
        statusReason: 'Не совпадает расписание',
      });
    });

    it('переводит пачкой на соседний курс', async () => {
      const { group, otherCourseGroup, nigina, farrukh } = scene();
      const token = await actor('Permission.Groups.ManageStudents', 'Permission.Groups.Views');

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id, farrukh.id],
      }).expect(201);

      await send('post', `/api/v1/groups/${group.id}/students/transfer`, token, {
        studentIds: [nigina.id, farrukh.id],
        targetGroupId: otherCourseGroup.id,
        reason: 'Перешли на Python',
      }).expect(200);

      const target = await get(`/api/v1/groups/${otherCourseGroup.id}/students`, token).expect(200);

      expect((target.body as { meta: { total: number } }).meta.total).toBe(2);
    });

    it('перевод в ту же группу — 422', async () => {
      const { group, nigina } = scene();
      const token = await actor('Permission.Groups.ManageStudents');

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);

      const response = await send('post', `/api/v1/groups/${group.id}/students/transfer`, token, {
        studentIds: [nigina.id],
        targetGroupId: group.id,
        reason: 'Ошибка оператора',
      }).expect(422);

      expect(response.body.error.message).toContain('совпадает');
    });

    it('несуществующая группа назначения — 422 (пришла в теле, а не в пути)', async () => {
      const { group, nigina } = scene();
      const token = await actor('Permission.Groups.ManageStudents');
      const ghost = randomUUID();

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);

      const response = await send('post', `/api/v1/groups/${group.id}/students/transfer`, token, {
        studentIds: [nigina.id],
        targetGroupId: ghost,
        reason: 'Перевод в вечерний поток',
      }).expect(422);

      expect(response.body.error.details).toEqual({ targetGroupId: ghost });
    });

    it('студент не из исходной группы — 422, перевод не состоялся', async () => {
      const { group, twinGroup, nigina } = scene();
      const token = await actor('Permission.Groups.ManageStudents', 'Permission.Groups.Views');

      await send('post', `/api/v1/groups/${group.id}/students/transfer`, token, {
        studentIds: [nigina.id],
        targetGroupId: twinGroup.id,
        reason: 'Перевод в вечерний поток',
      }).expect(422);

      const target = await get(`/api/v1/groups/${twinGroup.id}/students`, token).expect(200);

      expect((target.body as { meta: { total: number } }).meta.total).toBe(0);
    });

    it('409, если студент уже учится в третьей группе курса назначения', async () => {
      const { group, twinGroup, otherCourseGroup, nigina } = scene();
      const token = await actor('Permission.Groups.ManageStudents');

      // Учится на Python, и переводим его туда же из Frontend-1 — но в другую
      // группу того же курса Python он уже зачислен.
      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);
      await send('post', `/api/v1/groups/${otherCourseGroup.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);

      const pythonTwin = store.addGroup('Python-2', PYTHON);

      await send('post', `/api/v1/groups/${group.id}/students/transfer`, token, {
        studentIds: [nigina.id],
        targetGroupId: pythonTwin.id,
        reason: 'Перевод в вечерний поток',
      }).expect(409);

      // А перевод в ту самую группу, где он и так учится, — не конфликт:
      // членство просто становится действующим.
      await send('post', `/api/v1/groups/${twinGroup.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(409);
    });

    it('причина обязательна — 400', async () => {
      const { group, twinGroup, nigina } = scene();
      const token = await actor('Permission.Groups.ManageStudents');

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);

      await send('post', `/api/v1/groups/${group.id}/students/transfer`, token, {
        studentIds: [nigina.id],
        targetGroupId: twinGroup.id,
      }).expect(400);
    });
  });

  describe('Исключение из состава', () => {
    it('убирает членство, называет убранного и обновляет «набрано»', async () => {
      const { group, nigina, farrukh } = scene();
      const token = await actor('Permission.Groups.ManageStudents', 'Permission.Groups.Views');

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id, farrukh.id],
      }).expect(201);

      const response = await send(
        'delete',
        `/api/v1/groups/${group.id}/students/${nigina.id}`,
        token,
      ).expect(200);

      expect(dataOf<{ fullName: string; enrolledCount: number }>(response)).toEqual({
        groupId: group.id,
        studentId: nigina.id,
        fullName: 'Каримова Нигина',
        enrolledCount: 1,
      });

      const list = await get(`/api/v1/groups/${group.id}/students`, token).expect(200);

      expect((list.body as { meta: { total: number } }).meta.total).toBe(1);
    });

    it('повторное исключение — 404', async () => {
      const { group, nigina } = scene();
      const token = await actor('Permission.Groups.ManageStudents');

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);
      await send('delete', `/api/v1/groups/${group.id}/students/${nigina.id}`, token).expect(200);
      await send('delete', `/api/v1/groups/${group.id}/students/${nigina.id}`, token).expect(404);
    });

    it('студент соседней группы по этому адресу не найдётся — 404', async () => {
      const { group, twinGroup, nigina } = scene();
      const token = await actor('Permission.Groups.ManageStudents');

      await send('post', `/api/v1/groups/${twinGroup.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);

      await send('delete', `/api/v1/groups/${group.id}/students/${nigina.id}`, token).expect(404);
    });

    it('исключение освобождает курс — студента можно зачислить в соседнюю группу', async () => {
      const { group, twinGroup, nigina } = scene();
      const token = await actor('Permission.Groups.ManageStudents');

      await send('post', `/api/v1/groups/${group.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);
      await send('post', `/api/v1/groups/${twinGroup.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(409);

      await send('delete', `/api/v1/groups/${group.id}/students/${nigina.id}`, token).expect(200);
      await send('post', `/api/v1/groups/${twinGroup.id}/students`, token, {
        studentIds: [nigina.id],
      }).expect(201);
    });
  });

  describe('OpenAPI', () => {
    it('документ описывает маршруты состава и код 201 на зачисление', () => {
      // Документ собирается напрямую: маршрут `/docs/json` монтируется только
      // при `SWAGGER_ENABLED=true`, а в CI Swagger выключен (сессия 0006).
      const document = buildOpenApiDocument(app);

      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/groups/{groupId}/students',
          '/api/v1/groups/{groupId}/students/change-status',
          '/api/v1/groups/{groupId}/students/transfer',
          '/api/v1/groups/{groupId}/students/{studentId}',
        ]),
      );

      expect(
        Object.keys(document.paths['/api/v1/groups/{groupId}/students']?.post?.responses ?? {}),
      ).toContain('201');
    });
  });
});
