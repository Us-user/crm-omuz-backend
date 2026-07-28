import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  AccountType,
  DurationUnit,
  GraduateEmployment,
  GroupFormat,
  GroupStatus,
  GroupStudentStatus,
  StudentStatus,
} from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, SortOrder, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { GraduateSortField } from 'src/graduates/dto';
import { GraduatesModule } from 'src/graduates/graduates.module';
import type {
  CertificateInput,
  GraduateFilter,
  GraduateInput,
  GraduateListParams,
  GraduateRow,
  GraduateUpdateInput,
  GraduationGroup,
  StudentScore,
  StudentStatusUpdate,
} from 'src/graduates/graduates.repository';
import { GraduatesRepository } from 'src/graduates/graduates.repository';
import { GroupsModule } from 'src/groups/groups.module';
import type { GroupRow, GroupUpdateInput } from 'src/groups/groups.repository';
import { GroupsRepository } from 'src/groups/groups.repository';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { PhoneModule } from 'src/phone/phone.module';
import { RbacModule } from 'src/rbac/rbac.module';
import { RbacRepository } from 'src/rbac/rbac.repository';
import { buildOpenApiDocument } from 'src/swagger';

/** `{ data }` ответа с ожидаемым типом — тела supertest типизированы как `any`. */
const dataOf = <T>(response: { body: unknown }): T => (response.body as { data: T }).data;
const metaOf = <T>(response: { body: unknown }): T => (response.body as { meta: T }).meta;

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

interface StoredStudent {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  status: StudentStatus;
  /** Итоги **финализированных** недель: из них выводится общий балл (ТЗ 5.8). */
  finalizedSums: number[];
}

interface StoredGroup {
  id: string;
  name: string;
  courseId: string;
  courseTitle: string;
  isLastCourse: boolean;
  branchId: string;
  branchName: string;
  endDate: Date | null;
  status: GroupStatus;
}

interface StoredMembership {
  groupId: string;
  studentId: string;
  status: GroupStudentStatus;
  statusReason: string | null;
  statusChangedAt: Date | null;
  mentorAtLeaveId: string | null;
}

interface StoredGraduate {
  id: string;
  studentId: string;
  groupId: string;
  graduatedAt: Date;
  points: number | null;
  weeksCount: number;
  employment: GraduateEmployment | null;
  workPlace: string | null;
  certificateSerial: string | null;
  certificateIssuedAt: Date | null;
  certificateIssuedById: string | null;
  createdAt: Date;
}

/**
 * Студенты, группы, членства, итоги недель и выпуски **вместе** — одно
 * хранилище подставляется сразу на `GraduatesRepository` и `GroupsRepository`.
 *
 * Иначе главное свойство сессии проверить нечем: автовыпуск запускает правка
 * группы, а записи заводит модуль выпускников, и два разведённых хранилища
 * проверяли бы каждое своё, а не то, что связывает их между собой.
 *
 * Отбор витрины здесь **повторяет правила репозитория** (фильтры, период,
 * поиск), а не подставляет готовые строки; уникальность пары
 * «группа + студент» и уникальность серийного номера тоже держит хранилище —
 * на них стоят индексы в БД.
 */
class InMemoryStore {
  readonly students = new Map<string, StoredStudent>();
  readonly groups = new Map<string, StoredGroup>();
  readonly employees = new Map<string, { id: string; firstName: string; lastName: string }>();
  readonly memberships: StoredMembership[] = [];
  readonly graduates: StoredGraduate[] = [];
  /** Аккаунт → профиль сотрудника: им подписывается выданный сертификат. */
  readonly employeeByAccount = new Map<string, string>();

  addStudent(lastName = 'Каримова', finalizedSums: number[] = []): string {
    const id = randomUUID();
    this.students.set(id, {
      id,
      firstName: 'Нигина',
      lastName,
      phone: `+99290${String(this.students.size).padStart(7, '0')}`,
      status: StudentStatus.ACTIVE,
      finalizedSums,
    });

    return id;
  }

  addEmployee(accountId?: string): string {
    const id = randomUUID();
    this.employees.set(id, { id, firstName: 'Фаррух', lastName: 'Раҳимов' });
    if (accountId !== undefined) this.employeeByAccount.set(accountId, id);

    return id;
  }

  addGroup(overrides: Partial<StoredGroup> = {}): string {
    const id = randomUUID();
    this.groups.set(id, {
      id,
      name: `Frontend-${String(this.groups.size + 1)}`,
      courseId: COURSE_ID,
      courseTitle: 'Frontend Pro',
      isLastCourse: true,
      branchId: BRANCH_ID,
      branchName: 'Sadbarg',
      endDate: new Date('2026-06-30T00:00:00.000Z'),
      status: GroupStatus.ACTIVE,
      ...overrides,
    });

    return id;
  }

  enroll(groupId: string, studentId: string): void {
    this.memberships.push({
      groupId,
      studentId,
      status: GroupStudentStatus.ACTIVE,
      statusReason: null,
      statusChangedAt: null,
      mentorAtLeaveId: randomUUID(),
    });
  }

  /** Закрытое членство прямо в хранилище — когда путь ухода не проверяется. */
  seedClosed(groupId: string, studentId: string, status: GroupStudentStatus): void {
    this.memberships.push({
      groupId,
      studentId,
      status,
      statusReason: 'Переехал в другой город',
      statusChangedAt: new Date('2026-05-01T00:00:00.000Z'),
      mentorAtLeaveId: null,
    });
  }

  /** Готовый выпуск — когда проверяется витрина, а не сам автовыпуск. */
  seedGraduate(
    groupId: string,
    studentId: string,
    overrides: Partial<StoredGraduate> = {},
  ): string {
    const id = randomUUID();
    this.graduates.push({
      id,
      studentId,
      groupId,
      graduatedAt: new Date('2026-06-30T00:00:00.000Z'),
      points: 87.33,
      weeksCount: 12,
      employment: null,
      workPlace: null,
      certificateSerial: null,
      certificateIssuedAt: null,
      certificateIssuedById: null,
      createdAt: new Date('2026-06-30T09:00:00.000Z'),
      ...overrides,
    });

    return id;
  }

  membershipOf(groupId: string, studentId: string): StoredMembership | undefined {
    return this.memberships.find((m) => m.groupId === groupId && m.studentId === studentId);
  }

  // ─── GroupsRepository ───

  findGroupById(id: string): Promise<GroupRow | null> {
    const group = this.groups.get(id);

    return Promise.resolve(group === undefined ? null : this.toGroupRow(group));
  }

  updateGroup(id: string, input: GroupUpdateInput): Promise<GroupRow> {
    const group = this.groups.get(id);
    if (group === undefined) throw new Error('нет группы');
    if (input.status !== undefined) group.status = input.status;
    if (input.name !== undefined) group.name = input.name;

    return Promise.resolve(this.toGroupRow(group));
  }

  countGroupStudents(groupId: string): Promise<number> {
    return Promise.resolve(this.memberships.filter((m) => m.groupId === groupId).length);
  }

  countGroupGraduates(groupId: string): Promise<number> {
    return Promise.resolve(this.graduates.filter((g) => g.groupId === groupId).length);
  }

  deleteGroup(id: string): Promise<void> {
    this.groups.delete(id);

    return Promise.resolve();
  }

  // ─── GraduatesRepository: автовыпуск ───

  findGroupForGraduation(groupId: string): Promise<GraduationGroup | null> {
    const group = this.groups.get(groupId);

    return Promise.resolve(
      group === undefined
        ? null
        : {
            id: group.id,
            name: group.name,
            endDate: group.endDate,
            course: {
              id: group.courseId,
              title: group.courseTitle,
              isLastCourse: group.isLastCourse,
            },
          },
    );
  }

  findActiveMemberIds(groupId: string): Promise<string[]> {
    return Promise.resolve(
      this.memberships
        .filter((m) => m.groupId === groupId && m.status === GroupStudentStatus.ACTIVE)
        .map((m) => m.studentId),
    );
  }

  findGraduatedStudentIds(groupId: string): Promise<string[]> {
    return Promise.resolve(
      this.graduates.filter((g) => g.groupId === groupId).map((g) => g.studentId),
    );
  }

  /** Средний балл по **всем** финализированным неделям студента (ТЗ 5.8). */
  findScores(studentIds: string[]): Promise<StudentScore[]> {
    return Promise.resolve(
      studentIds.flatMap((studentId) => {
        const sums = this.students.get(studentId)?.finalizedSums ?? [];
        if (sums.length === 0) return [];

        return [
          {
            studentId,
            average: sums.reduce((total, sum) => total + sum, 0) / sums.length,
            weeksCount: sums.length,
          },
        ];
      }),
    );
  }

  graduate(
    groupId: string,
    graduates: GraduateInput[],
    memberIds: string[],
    graduatedAt: Date,
    reason: string,
  ): Promise<GraduateRow[]> {
    for (const input of graduates) {
      // Уникальный индекс `(groupId, studentId)`: второй строки не заводим.
      const exists = this.graduates.some(
        (g) => g.groupId === groupId && g.studentId === input.studentId,
      );
      if (exists) continue;

      this.seedGraduate(groupId, input.studentId, {
        graduatedAt,
        points: input.points,
        weeksCount: input.weeksCount,
        createdAt: new Date(),
      });
    }

    for (const membership of this.memberships) {
      if (membership.groupId !== groupId) continue;
      if (!memberIds.includes(membership.studentId)) continue;
      // Только действующие: закрытые строки — учебная история, и выпуск
      // не имеет права её затирать.
      if (membership.status !== GroupStudentStatus.ACTIVE) continue;

      membership.status = GroupStudentStatus.FINISHED;
      membership.statusReason = reason;
      membership.statusChangedAt = graduatedAt;
      membership.mentorAtLeaveId = null;
    }

    return Promise.resolve(
      this.graduates
        .filter((g) => g.groupId === groupId && memberIds.includes(g.studentId))
        .map((g) => this.toGraduateRow(g)),
    );
  }

  findStudentsWithMemberships(
    studentIds: string[],
  ): Promise<{ id: string; status: StudentStatus; groups: unknown[] }[]> {
    return Promise.resolve(
      studentIds.flatMap((id) => {
        const student = this.students.get(id);
        if (student === undefined) return [];

        return [
          {
            id,
            status: student.status,
            groups: this.memberships
              .filter((m) => m.studentId === id)
              .map((m) => ({ status: m.status, statusChangedAt: m.statusChangedAt })),
          },
        ];
      }),
    );
  }

  setStudentStatuses(updates: StudentStatusUpdate[]): Promise<void> {
    for (const { studentId, status } of updates) {
      const student = this.students.get(studentId);
      if (student !== undefined) student.status = status;
    }

    return Promise.resolve();
  }

  // ─── GraduatesRepository: витрина ───

  findMany(params: GraduateListParams): Promise<{ rows: GraduateRow[]; total: number }> {
    const matched = this.graduates.filter((g) => this.matches(g, params));

    const sorted = [...matched].sort((a, b) => {
      const direction = params.order === SortOrder.Asc ? 1 : -1;

      if (params.sort === GraduateSortField.Name) {
        const first = this.students.get(a.studentId);
        const second = this.students.get(b.studentId);

        return (
          direction *
          (compare(first?.lastName ?? '', second?.lastName ?? '') ||
            compare(first?.firstName ?? '', second?.firstName ?? ''))
        );
      }

      if (params.sort === GraduateSortField.Points) {
        // Пустой балл всегда в конце — как `nulls: 'last'` в репозитории.
        if (a.points === null) return 1;
        if (b.points === null) return -1;

        return direction * (a.points - b.points);
      }

      return direction * (a.graduatedAt.getTime() - b.graduatedAt.getTime());
    });

    return Promise.resolve({
      rows: sorted.slice(params.skip, params.skip + params.take).map((g) => this.toGraduateRow(g)),
      total: sorted.length,
    });
  }

  countByEmployment(
    filter: GraduateFilter,
  ): Promise<{ employment: GraduateEmployment | null; count: number }[]> {
    const counts = new Map<GraduateEmployment | null, number>();

    for (const graduate of this.graduates.filter((g) => this.matches(g, filter))) {
      counts.set(graduate.employment, (counts.get(graduate.employment) ?? 0) + 1);
    }

    return Promise.resolve([...counts].map(([employment, count]) => ({ employment, count })));
  }

  findById(id: string): Promise<GraduateRow | null> {
    const graduate = this.graduates.find((g) => g.id === id);

    return Promise.resolve(graduate === undefined ? null : this.toGraduateRow(graduate));
  }

  findBySerial(serial: string): Promise<{ id: string; certificateSerial: string | null } | null> {
    const graduate = this.graduates.find((g) => g.certificateSerial === serial);

    return Promise.resolve(
      graduate === undefined
        ? null
        : { id: graduate.id, certificateSerial: graduate.certificateSerial },
    );
  }

  update(id: string, input: GraduateUpdateInput): Promise<GraduateRow> {
    const graduate = this.require(id);
    if (input.employment !== undefined) graduate.employment = input.employment;
    if (input.workPlace !== undefined) graduate.workPlace = input.workPlace;
    if (input.graduatedAt !== undefined) graduate.graduatedAt = input.graduatedAt;

    return Promise.resolve(this.toGraduateRow(graduate));
  }

  issueCertificate(id: string, input: CertificateInput): Promise<GraduateRow> {
    const graduate = this.require(id);
    graduate.certificateSerial = input.serial;
    graduate.certificateIssuedAt = input.issuedAt;
    graduate.certificateIssuedById = input.issuedById;

    return Promise.resolve(this.toGraduateRow(graduate));
  }

  revokeCertificate(id: string): Promise<GraduateRow> {
    const graduate = this.require(id);
    graduate.certificateSerial = null;
    graduate.certificateIssuedAt = null;
    graduate.certificateIssuedById = null;

    return Promise.resolve(this.toGraduateRow(graduate));
  }

  findEmployeeByAccount(accountId: string): Promise<{ id: string } | null> {
    const employeeId = this.employeeByAccount.get(accountId);

    return Promise.resolve(employeeId === undefined ? null : { id: employeeId });
  }

  // ─── Правила выборки витрины (повторяют `whereOf` репозитория) ───

  private matches(graduate: StoredGraduate, filter: GraduateFilter): boolean {
    const group = this.groups.get(graduate.groupId);

    if (filter.groupId !== undefined && graduate.groupId !== filter.groupId) return false;
    if (filter.courseId !== undefined && group?.courseId !== filter.courseId) return false;
    if (filter.branchId !== undefined && group?.branchId !== filter.branchId) return false;
    if (filter.employment !== undefined && graduate.employment !== filter.employment) return false;
    if (
      filter.hasCertificate !== undefined &&
      (graduate.certificateSerial !== null) !== filter.hasCertificate
    ) {
      return false;
    }
    if (filter.from !== undefined && graduate.graduatedAt < filter.from) return false;
    if (filter.to !== undefined && graduate.graduatedAt >= filter.to) return false;

    if (filter.search !== undefined) {
      const needle = filter.search.toLowerCase();
      const student = this.students.get(graduate.studentId);
      const haystack = [
        student?.firstName ?? '',
        student?.lastName ?? '',
        student?.phone ?? '',
        graduate.workPlace ?? '',
        graduate.certificateSerial ?? '',
      ].map((value) => value.toLowerCase());

      if (!haystack.some((value) => value.includes(needle))) return false;
    }

    return true;
  }

  private require(id: string): StoredGraduate {
    const graduate = this.graduates.find((g) => g.id === id);
    if (graduate === undefined) throw new Error('нет выпускника');

    return graduate;
  }

  private toGroupRow(group: StoredGroup): GroupRow {
    return {
      id: group.id,
      name: group.name,
      description: null,
      course: { id: group.courseId, title: group.courseTitle, isLastCourse: group.isLastCourse },
      branch: { id: group.branchId, name: group.branchName },
      format: GroupFormat.OFFLINE,
      startDate: new Date('2026-04-01T00:00:00.000Z'),
      endDate: group.endDate,
      durationValue: 3,
      durationUnit: DurationUnit.MONTH,
      capacity: 16,
      status: group.status,
      telegramUrl: null,
      _count: {
        students: this.memberships.filter(
          (m) => m.groupId === group.id && m.status === GroupStudentStatus.ACTIVE,
        ).length,
      },
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
    };
  }

  private toGraduateRow(graduate: StoredGraduate): GraduateRow {
    const student = this.students.get(graduate.studentId);
    const group = this.groups.get(graduate.groupId);
    const issuer =
      graduate.certificateIssuedById === null
        ? null
        : (this.employees.get(graduate.certificateIssuedById) ?? null);

    return {
      id: graduate.id,
      graduatedAt: graduate.graduatedAt,
      points: graduate.points as unknown as GraduateRow['points'],
      weeksCount: graduate.weeksCount,
      employment: graduate.employment,
      workPlace: graduate.workPlace,
      certificateSerial: graduate.certificateSerial,
      certificateIssuedAt: graduate.certificateIssuedAt,
      createdAt: graduate.createdAt,
      student: {
        id: graduate.studentId,
        firstName: student?.firstName ?? '',
        lastName: student?.lastName ?? '',
        phone: student?.phone ?? '',
        photoUrl: null,
        status: student?.status ?? StudentStatus.ACTIVE,
      },
      group: {
        id: graduate.groupId,
        name: group?.name ?? '',
        course: { id: group?.courseId ?? '', title: group?.courseTitle ?? '' },
        branch: { id: group?.branchId ?? '', name: group?.branchName ?? '' },
      },
      certificateIssuedBy: issuer,
    };
  }
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Настоящие v4-идентификаторы, а не рукописные: `@IsUUID()` проверяет вариант,
// и «44444444-…» не прошёл бы валидацию фильтра (находка сессии 0024).
const COURSE_ID = randomUUID();
const OTHER_COURSE_ID = randomUUID();
const BRANCH_ID = randomUUID();
const OTHER_BRANCH_ID = randomUUID();

interface GraduateItem {
  id: string;
  student: { id: string; lastName: string; status: StudentStatus };
  group: { id: string; name: string };
  course: { id: string; name: string };
  branch: { id: string; name: string };
  graduatedAt: string;
  points: number | null;
  weeksCount: number;
  level: string | null;
  levelTitle: string | null;
  employment: GraduateEmployment | null;
  workPlace: string | null;
  certificate: {
    issued: boolean;
    serial: string | null;
    issuedAt: string | null;
    issuedBy: { id: string; lastName: string } | null;
  };
}

interface EmploymentMeta {
  employment: {
    openToWork: number;
    work: number;
    freelancer: number;
    furtherEducation: number;
    entrepreneur: number;
    unknown: number;
  };
}

describe('Выпускники (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryStore;
  let rbac: InMemoryRbacRepository;
  let tokens: TokenService;

  beforeEach(async () => {
    store = new InMemoryStore();
    rbac = new InMemoryRbacRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        PhoneModule,
        AuthModule,
        RbacModule,
        GraduatesModule,
        // Группы поднимаются вместе с витриной: именно перевод группы
        // в `FINISHED` запускает автовыпуск (ТЗ 5.11).
        GroupsModule,
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
      .overrideProvider(GraduatesRepository)
      .useValue(store)
      .overrideProvider(GroupsRepository)
      .useValue({
        findById: (id: string) => store.findGroupById(id),
        findByName: () => Promise.resolve(null),
        findBranch: (id: string) => Promise.resolve({ id, name: 'Sadbarg' }),
        findCourse: (id: string) => Promise.resolve({ id, title: 'Frontend Pro' }),
        countScheduleSlotsWithRoom: () => Promise.resolve(0),
        countStudents: (id: string) => store.countGroupStudents(id),
        countGraduates: (id: string) => store.countGroupGraduates(id),
        countCharges: () => Promise.resolve(0),
        // Журнала в этом наборе нет: счётчики категорий (ТЗ 5.5) проверяет
        // `performance.e2e-spec.ts`, где живут недели и их итоги.
        findActivity: () => Promise.resolve({ members: [], results: [] }),
        update: (id: string, input: GroupUpdateInput) => store.updateGroup(id, input),
        delete: (id: string) => store.deleteGroup(id),
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

  const actor = async (codes: string[]): Promise<{ token: string; accountId: string }> => {
    const accountId = randomUUID();
    rbac.grant(accountId, codes);
    const { accessToken } = await tokens.issuePair({
      sub: accountId,
      sid: randomUUID(),
      type: AccountType.EMPLOYEE,
    });

    return { token: accessToken, accountId };
  };

  const viewer = async () => (await actor(['Permission.Graduates.Views'])).token;
  const editor = async () =>
    (await actor(['Permission.Graduates.Views', 'Permission.Graduates.Update'])).token;
  const registrar = () => actor(['Permission.Graduates.Views', 'Permission.Graduates.Certificate']);
  const groupManager = async () =>
    (await actor(['Permission.Graduates.Views', 'Permission.Groups.Update'])).token;

  const studentToken = async (): Promise<string> =>
    (await tokens.issuePair({ sub: randomUUID(), sid: randomUUID(), type: AccountType.STUDENT }))
      .accessToken;

  const get = (url: string, token: string) =>
    request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);

  const send = (method: 'post' | 'put' | 'delete', url: string, token: string, body?: object) => {
    const req = request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`);

    return body === undefined ? req : req.send(body);
  };

  /** Закрытие группы настоящим маршрутом (ТЗ 5.5) — то самое событие выпуска. */
  const finishGroup = (token: string, groupId: string) =>
    send('put', `/api/v1/groups/${groupId}`, token, { status: GroupStatus.FINISHED });

  describe('Доступ', () => {
    it('без токена — 401', async () => {
      await request(app.getHttpServer()).get('/api/v1/graduates').expect(401);
    });

    it('студенту витрина закрыта — 403', async () => {
      await get('/api/v1/graduates', await studentToken()).expect(403);
    });

    it('сотрудник без прав — 403', async () => {
      await get('/api/v1/graduates', (await actor([])).token).expect(403);
    });

    it('право на просмотр не даёт править карточку', async () => {
      const token = await viewer();
      const groupId = store.addGroup();
      const id = store.seedGraduate(groupId, store.addStudent());

      await get(`/api/v1/graduates/${id}`, token).expect(200);
      await send('put', `/api/v1/graduates/${id}`, token, {
        employment: GraduateEmployment.WORK,
      }).expect(403);
    });

    it('право на правку карточки не даёт выдавать сертификат', async () => {
      const token = await editor();
      const groupId = store.addGroup();
      const id = store.seedGraduate(groupId, store.addStudent());

      await send('put', `/api/v1/graduates/${id}`, token, {
        employment: GraduateEmployment.WORK,
      }).expect(200);
      await send('post', `/api/v1/graduates/${id}/certificate`, token, {
        serial: 'OMZ-1',
      }).expect(403);
    });

    it('право на выдачу сертификата не заменяет право на правку карточки', async () => {
      const { token } = await registrar();
      const groupId = store.addGroup();
      const id = store.seedGraduate(groupId, store.addStudent());

      await send('post', `/api/v1/graduates/${id}/certificate`, token, {
        serial: 'OMZ-1',
      }).expect(201);
      await send('put', `/api/v1/graduates/${id}`, token, {
        employment: GraduateEmployment.WORK,
      }).expect(403);
    });

    it('право на студентов витрину выпускников не открывает', async () => {
      const token = (await actor(['Permission.Students.Views'])).token;

      await get('/api/v1/graduates', token).expect(403);
    });
  });

  describe('Автовыпуск (ТЗ 5.11)', () => {
    // Главное свойство сессии, проверенное настоящими запросами через два модуля.
    it('перевод группы «Is last course» в FINISHED заводит выпускников', async () => {
      const token = await groupManager();
      const groupId = store.addGroup();
      const studentId = store.addStudent('Каримова', [90, 85]);
      store.enroll(groupId, studentId);

      await finishGroup(token, groupId).expect(200);

      const rows = dataOf<GraduateItem[]>(await get('/api/v1/graduates', token).expect(200));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        student: { id: studentId, lastName: 'Каримова' },
        group: { id: groupId },
        course: { name: 'Frontend Pro' },
        branch: { name: 'Sadbarg' },
        graduatedAt: '2026-06-30',
        points: 87.5,
        weeksCount: 2,
        level: 'HANDSOME',
        levelTitle: 'Handsome',
      });
    });

    it('членства выпускников закрываются как FINISHED, а профиль пересчитывается', async () => {
      const token = await groupManager();
      const groupId = store.addGroup();
      const studentId = store.addStudent('Каримова', [90]);
      store.enroll(groupId, studentId);

      await finishGroup(token, groupId).expect(200);

      expect(store.membershipOf(groupId, studentId)).toMatchObject({
        status: GroupStudentStatus.FINISHED,
        mentorAtLeaveId: null,
      });
      expect(store.students.get(studentId)?.status).toBe(StudentStatus.FINISHED);
    });

    it('курс без «Is last course» никого не выпускает', async () => {
      const token = await groupManager();
      const groupId = store.addGroup({ isLastCourse: false, courseId: OTHER_COURSE_ID });
      const studentId = store.addStudent('Каримова', [90]);
      store.enroll(groupId, studentId);

      await finishGroup(token, groupId).expect(200);

      expect(dataOf<GraduateItem[]>(await get('/api/v1/graduates', token))).toEqual([]);
      // И членство остаётся действующим: человек идёт учиться дальше.
      expect(store.membershipOf(groupId, studentId)?.status).toBe(GroupStudentStatus.ACTIVE);
    });

    it('ушедшие и переведённые дипломов не получают', async () => {
      const token = await groupManager();
      const groupId = store.addGroup();
      const graduating = store.addStudent('Выпускница', [90]);
      const left = store.addStudent('Ушедшая', [90]);
      const transferred = store.addStudent('Переведённая', [90]);
      store.enroll(groupId, graduating);
      store.seedClosed(groupId, left, GroupStudentStatus.LEFT);
      store.seedClosed(groupId, transferred, GroupStudentStatus.TRANSFERRED);

      await finishGroup(token, groupId).expect(200);

      const rows = dataOf<GraduateItem[]>(await get('/api/v1/graduates', token).expect(200));
      expect(rows.map((row) => row.student.lastName)).toEqual(['Выпускница']);
      // Причина и дата ухода не переписаны выпуском.
      expect(store.membershipOf(groupId, left)).toMatchObject({
        status: GroupStudentStatus.LEFT,
        statusReason: 'Переехал в другой город',
      });
    });

    // Ради этого автовыпуск проверяет итоговое состояние, а не переход.
    it('повторное сохранение завершённой группы второго диплома не заводит', async () => {
      const token = await groupManager();
      const groupId = store.addGroup();
      store.enroll(groupId, store.addStudent('Каримова', [90]));

      await finishGroup(token, groupId).expect(200);
      await finishGroup(token, groupId).expect(200);

      expect(metaOf<{ total: number }>(await get('/api/v1/graduates', token))).toMatchObject({
        total: 1,
      });
    });

    it('выпускник без закрытых недель получает points: null, а не ноль', async () => {
      const token = await groupManager();
      const groupId = store.addGroup();
      store.enroll(groupId, store.addStudent('Каримова'));

      await finishGroup(token, groupId).expect(200);

      const rows = dataOf<GraduateItem[]>(await get('/api/v1/graduates', token).expect(200));
      expect(rows[0]).toMatchObject({ points: null, weeksCount: 0, level: null, levelTitle: null });
    });

    // Снимок: правка журнала задним числом диплом не переписывает.
    it('изменение итогов недель после выпуска балл выпускника не меняет', async () => {
      const token = await groupManager();
      const groupId = store.addGroup();
      const studentId = store.addStudent('Каримова', [100]);
      store.enroll(groupId, studentId);

      await finishGroup(token, groupId).expect(200);
      const student = store.students.get(studentId);
      if (student !== undefined) student.finalizedSums = [10];

      const rows = dataOf<GraduateItem[]>(await get('/api/v1/graduates', token).expect(200));
      expect(rows[0]).toMatchObject({ points: 100, level: 'CHAT_GPT' });
    });

    it('без срока группы датой выпуска становится день закрытия', async () => {
      const token = await groupManager();
      const groupId = store.addGroup({ endDate: null });
      store.enroll(groupId, store.addStudent('Каримова', [90]));

      await finishGroup(token, groupId).expect(200);

      const rows = dataOf<GraduateItem[]>(await get('/api/v1/graduates', token).expect(200));
      expect(rows[0]?.graduatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('перевод группы в другой статус выпуска не запускает', async () => {
      const token = await groupManager();
      const groupId = store.addGroup();
      store.enroll(groupId, store.addStudent('Каримова', [90]));

      await send('put', `/api/v1/groups/${groupId}`, token, {
        status: GroupStatus.CANCELLED,
      }).expect(200);

      expect(dataOf<GraduateItem[]>(await get('/api/v1/graduates', token))).toEqual([]);
    });

    it('группа без действующего состава закрывается без выпускников', async () => {
      const token = await groupManager();
      const groupId = store.addGroup();
      store.seedClosed(groupId, store.addStudent('Ушедшая'), GroupStudentStatus.LEFT);

      await finishGroup(token, groupId).expect(200);

      expect(dataOf<GraduateItem[]>(await get('/api/v1/graduates', token))).toEqual([]);
    });

    // Состав можно разобрать руками (`DELETE …/students/{id}`, сессия 0012),
    // и тогда группу держит уже не он, а сам факт выпуска.
    it('группу с выпускниками удалить нельзя даже после разбора состава — 409', async () => {
      const { token } = await actor([
        'Permission.Graduates.Views',
        'Permission.Groups.Update',
        'Permission.Groups.Delete',
      ]);
      const groupId = store.addGroup();
      store.enroll(groupId, store.addStudent('Каримова', [90]));
      await finishGroup(token, groupId).expect(200);

      // Состав разобран — остаются только записи о выпуске.
      store.memberships.length = 0;

      const response = await send('delete', `/api/v1/groups/${groupId}`, token).expect(409);

      expect(JSON.stringify(response.body)).toContain('выпустились');
      expect(store.groups.has(groupId)).toBe(true);
    });
  });

  describe('Витрина выпускников', () => {
    it('отдаёт `{ data, meta }`, режет страницами и считает трудоустройство', async () => {
      const token = await viewer();
      const groupId = store.addGroup();
      store.seedGraduate(groupId, store.addStudent('Первая'), {
        employment: GraduateEmployment.WORK,
      });
      store.seedGraduate(groupId, store.addStudent('Вторая'), {
        employment: GraduateEmployment.WORK,
      });
      store.seedGraduate(groupId, store.addStudent('Третья'));

      const response = await get('/api/v1/graduates?limit=2', token).expect(200);

      expect(dataOf<GraduateItem[]>(response)).toHaveLength(2);
      const meta = metaOf<{ total: number; totalPages: number } & EmploymentMeta>(response);
      expect(meta).toMatchObject({ total: 3, totalPages: 2 });
      // Счётчики считаются по всему набору, а не по странице.
      expect(meta.employment).toEqual({
        openToWork: 0,
        work: 2,
        freelancer: 0,
        furtherEducation: 0,
        entrepreneur: 0,
        unknown: 1,
      });
    });

    it('невыясненный статус считается отдельно от «ищет работу»', async () => {
      const token = await viewer();
      const groupId = store.addGroup();
      store.seedGraduate(groupId, store.addStudent('Первая'), {
        employment: GraduateEmployment.OPEN_TO_WORK,
      });
      store.seedGraduate(groupId, store.addStudent('Вторая'));

      const meta = metaOf<EmploymentMeta>(await get('/api/v1/graduates', token).expect(200));

      expect(meta.employment.openToWork).toBe(1);
      expect(meta.employment.unknown).toBe(1);
    });

    it('фильтры по группе, курсу, филиалу и трудоустройству', async () => {
      const token = await viewer();
      const frontend = store.addGroup({ name: 'Frontend-1' });
      const python = store.addGroup({
        name: 'Python-1',
        courseId: OTHER_COURSE_ID,
        courseTitle: 'Python Pro',
        branchId: OTHER_BRANCH_ID,
        branchName: 'Profsous',
      });
      store.seedGraduate(frontend, store.addStudent('Фронтова'), {
        employment: GraduateEmployment.WORK,
      });
      store.seedGraduate(python, store.addStudent('Питонова'), {
        employment: GraduateEmployment.FREELANCER,
      });

      const names = async (queryString: string): Promise<string[]> =>
        dataOf<GraduateItem[]>(
          await get(`/api/v1/graduates?${queryString}`, token).expect(200),
        ).map((row) => row.student.lastName);

      expect(await names(`groupId=${frontend}`)).toEqual(['Фронтова']);
      expect(await names(`courseId=${OTHER_COURSE_ID}`)).toEqual(['Питонова']);
      expect(await names(`branchId=${OTHER_BRANCH_ID}`)).toEqual(['Питонова']);
      expect(await names(`employment=${GraduateEmployment.WORK}`)).toEqual(['Фронтова']);
    });

    it('фильтр по наличию сертификата работает в обе стороны', async () => {
      const token = await viewer();
      const groupId = store.addGroup();
      store.seedGraduate(groupId, store.addStudent('Сдипломом'), {
        certificateSerial: 'OMZ-2026-000148',
      });
      store.seedGraduate(groupId, store.addStudent('Бездиплома'));

      const names = async (value: string): Promise<string[]> =>
        dataOf<GraduateItem[]>(
          await get(`/api/v1/graduates?hasCertificate=${value}`, token).expect(200),
        ).map((row) => row.student.lastName);

      expect(await names('true')).toEqual(['Сдипломом']);
      expect(await names('false')).toEqual(['Бездиплома']);
    });

    it('период выпуска задаётся месяцами и включает обе границы', async () => {
      const token = await viewer();
      const groupId = store.addGroup();
      const at = (date: string) => new Date(`${date}T00:00:00.000Z`);
      store.seedGraduate(groupId, store.addStudent('Мартовая'), { graduatedAt: at('2026-03-31') });
      store.seedGraduate(groupId, store.addStudent('Апрелевая'), { graduatedAt: at('2026-04-01') });
      store.seedGraduate(groupId, store.addStudent('Июньская'), { graduatedAt: at('2026-06-30') });
      store.seedGraduate(groupId, store.addStudent('Июлевая'), { graduatedAt: at('2026-07-01') });

      const rows = dataOf<GraduateItem[]>(
        await get('/api/v1/graduates?from=2026-04&to=2026-06&sort=name&order=asc', token).expect(
          200,
        ),
      );
      expect(rows.map((row) => row.student.lastName)).toEqual(['Апрелевая', 'Июньская']);
    });

    it('поиск идёт по фамилии, месту работы и номеру сертификата', async () => {
      const token = await viewer();
      const groupId = store.addGroup();
      store.seedGraduate(groupId, store.addStudent('Каримова'), {
        workPlace: 'ООО «Алиф Технолоджи»',
        certificateSerial: 'OMZ-2026-000148',
      });
      store.seedGraduate(groupId, store.addStudent('Шарипова'), { workPlace: 'Фриланс' });

      const names = async (needle: string): Promise<string[]> =>
        dataOf<GraduateItem[]>(await get(`/api/v1/graduates?search=${needle}`, token).expect(200))
          .map((row) => row.student.lastName)
          .sort();

      expect(await names('алиф')).toEqual(['Каримова']);
      expect(await names('000148')).toEqual(['Каримова']);
      expect(await names('шарипова')).toEqual(['Шарипова']);
    });

    it('сортировка по баллу кладёт выпускников без балла в конец', async () => {
      const token = await viewer();
      const groupId = store.addGroup();
      store.seedGraduate(groupId, store.addStudent('Слабая'), { points: 50 });
      store.seedGraduate(groupId, store.addStudent('Безбалла'), { points: null });
      store.seedGraduate(groupId, store.addStudent('Сильная'), { points: 95 });

      const rows = dataOf<GraduateItem[]>(
        await get('/api/v1/graduates?sort=points&order=desc', token).expect(200),
      );
      expect(rows.map((row) => row.student.lastName)).toEqual(['Сильная', 'Слабая', 'Безбалла']);
    });

    it('карточка выпускника и 404 на неизвестного', async () => {
      const token = await viewer();
      const groupId = store.addGroup();
      const id = store.seedGraduate(groupId, store.addStudent('Каримова'));

      const row = dataOf<GraduateItem>(await get(`/api/v1/graduates/${id}`, token).expect(200));
      expect(row).toMatchObject({ id, student: { lastName: 'Каримова' } });

      await get(`/api/v1/graduates/${randomUUID()}`, token).expect(404);
      await get('/api/v1/graduates/not-a-uuid', token).expect(400);
    });

    it('400 на негодный месяц и неизвестное поле сортировки', async () => {
      const token = await viewer();

      await get('/api/v1/graduates?from=2026-13', token).expect(400);
      await get('/api/v1/graduates?sort=diploma', token).expect(400);
      await get('/api/v1/graduates?groupId=not-a-uuid', token).expect(400);
    });
  });

  describe('Правка карточки', () => {
    it('проставляет трудоустройство и место работы, остальное не трогает', async () => {
      const token = await editor();
      const groupId = store.addGroup();
      const id = store.seedGraduate(groupId, store.addStudent('Каримова'), { points: 87.33 });

      const row = dataOf<GraduateItem>(
        await send('put', `/api/v1/graduates/${id}`, token, {
          employment: GraduateEmployment.WORK,
          workPlace: 'ООО «Алиф Технолоджи»',
        }).expect(200),
      );

      expect(row).toMatchObject({
        employment: GraduateEmployment.WORK,
        workPlace: 'ООО «Алиф Технолоджи»',
        points: 87.33,
      });
    });

    // Балл — снимок: править его руками означало бы «за что выдан сертификат»
    // ничем не подтверждённое.
    it('балл и уровень править нельзя — 400 на лишнее поле', async () => {
      const token = await editor();
      const groupId = store.addGroup();
      const id = store.seedGraduate(groupId, store.addStudent());

      await send('put', `/api/v1/graduates/${id}`, token, { points: 100 }).expect(400);
      await send('put', `/api/v1/graduates/${id}`, token, { level: 'CHAT_GPT' }).expect(400);
    });

    it('пустая строка очищает место работы', async () => {
      const token = await editor();
      const groupId = store.addGroup();
      const id = store.seedGraduate(groupId, store.addStudent(), { workPlace: 'Старое место' });

      const row = dataOf<GraduateItem>(
        await send('put', `/api/v1/graduates/${id}`, token, { workPlace: '' }).expect(200),
      );

      expect(row.workPlace).toBeNull();
    });

    it('дата выпуска правится, 400 на несуществующую', async () => {
      const token = await editor();
      const groupId = store.addGroup();
      const id = store.seedGraduate(groupId, store.addStudent());

      const row = dataOf<GraduateItem>(
        await send('put', `/api/v1/graduates/${id}`, token, {
          graduatedAt: '2026-07-15',
        }).expect(200),
      );
      expect(row.graduatedAt).toBe('2026-07-15');

      await send('put', `/api/v1/graduates/${id}`, token, { graduatedAt: '2026-02-30' }).expect(
        400,
      );
      await send('put', `/api/v1/graduates/${id}`, token, { graduatedAt: '15.07.2026' }).expect(
        400,
      );
    });

    it('404 на правку неизвестного выпускника', async () => {
      await send('put', `/api/v1/graduates/${randomUUID()}`, await editor(), {
        employment: GraduateEmployment.WORK,
      }).expect(404);
    });
  });

  describe('Сертификат (ТЗ 5.11, 3.7)', () => {
    it('выдаёт сертификат с номером, датой и подписью выдавшего', async () => {
      const { token, accountId } = await registrar();
      const employeeId = store.addEmployee(accountId);
      const groupId = store.addGroup();
      const id = store.seedGraduate(groupId, store.addStudent('Каримова'));

      const row = dataOf<GraduateItem>(
        await send('post', `/api/v1/graduates/${id}/certificate`, token, {
          serial: 'OMZ-2026-000148',
          issuedAt: '2026-07-05',
        }).expect(201),
      );

      expect(row.certificate).toMatchObject({
        issued: true,
        serial: 'OMZ-2026-000148',
        issuedAt: '2026-07-05',
        issuedBy: { id: employeeId, lastName: 'Раҳимов' },
      });
    });

    it('аккаунт без профиля сотрудника выдаёт сертификат без подписи', async () => {
      const { token } = await registrar();
      const groupId = store.addGroup();
      const id = store.seedGraduate(groupId, store.addStudent());

      const row = dataOf<GraduateItem>(
        await send('post', `/api/v1/graduates/${id}/certificate`, token, {
          serial: 'OMZ-1',
        }).expect(201),
      );

      expect(row.certificate.issuedBy).toBeNull();
      expect(row.certificate.issued).toBe(true);
    });

    it('повторная выдача — 409, прежний номер остаётся', async () => {
      const { token } = await registrar();
      const groupId = store.addGroup();
      const id = store.seedGraduate(groupId, store.addStudent(), {
        certificateSerial: 'OMZ-2026-000001',
      });

      const response = await send('post', `/api/v1/graduates/${id}/certificate`, token, {
        serial: 'OMZ-2026-000148',
      }).expect(409);

      expect(JSON.stringify(response.body)).toContain('OMZ-2026-000001');
      expect(store.graduates.find((g) => g.id === id)?.certificateSerial).toBe('OMZ-2026-000001');
    });

    it('номер уникален по всему центру — 409 на занятый другим выпускником', async () => {
      const { token } = await registrar();
      const groupId = store.addGroup();
      store.seedGraduate(groupId, store.addStudent('Первая'), {
        certificateSerial: 'OMZ-2026-000148',
      });
      const id = store.seedGraduate(groupId, store.addStudent('Вторая'));

      await send('post', `/api/v1/graduates/${id}/certificate`, token, {
        serial: 'OMZ-2026-000148',
      }).expect(409);
      expect(store.graduates.find((g) => g.id === id)?.certificateSerial).toBeNull();
    });

    // Весь круг: без снятия ошибочный номер остался бы занятым навсегда.
    it('снял выдачу — номер освободился и выдаётся другому', async () => {
      const { token } = await registrar();
      const groupId = store.addGroup();
      const first = store.seedGraduate(groupId, store.addStudent('Первая'));
      const second = store.seedGraduate(groupId, store.addStudent('Вторая'));

      await send('post', `/api/v1/graduates/${first}/certificate`, token, {
        serial: 'OMZ-2026-000148',
      }).expect(201);
      await send('post', `/api/v1/graduates/${second}/certificate`, token, {
        serial: 'OMZ-2026-000148',
      }).expect(409);

      const revoked = dataOf<GraduateItem>(
        await send('delete', `/api/v1/graduates/${first}/certificate`, token).expect(200),
      );
      expect(revoked.certificate).toMatchObject({ issued: false, serial: null, issuedAt: null });

      await send('post', `/api/v1/graduates/${second}/certificate`, token, {
        serial: 'OMZ-2026-000148',
      }).expect(201);
    });

    it('404 на снятие невыданного сертификата', async () => {
      const { token } = await registrar();
      const groupId = store.addGroup();
      const id = store.seedGraduate(groupId, store.addStudent());

      await send('delete', `/api/v1/graduates/${id}/certificate`, token).expect(404);
    });

    it('400 на короткий номер, отсутствующий номер и лишнее поле', async () => {
      const { token } = await registrar();
      const groupId = store.addGroup();
      const id = store.seedGraduate(groupId, store.addStudent());

      await send('post', `/api/v1/graduates/${id}/certificate`, token, { serial: 'X' }).expect(400);
      await send('post', `/api/v1/graduates/${id}/certificate`, token, {}).expect(400);
      await send('post', `/api/v1/graduates/${id}/certificate`, token, {
        serial: 'OMZ-1',
        issuedBy: randomUUID(),
      }).expect(400);
      expect(store.graduates.find((g) => g.id === id)?.certificateSerial).toBeNull();
    });

    it('404 на выдачу неизвестному выпускнику', async () => {
      const { token } = await registrar();

      await send('post', `/api/v1/graduates/${randomUUID()}/certificate`, token, {
        serial: 'OMZ-1',
      }).expect(404);
    });
  });

  describe('OpenAPI', () => {
    it('пути витрины описаны, и «создать выпускника» руками нельзя', () => {
      const document = buildOpenApiDocument(app);

      // Записи заводит только автовыпуск: `post /graduates` в документе быть
      // не должно — иначе появился бы второй источник истины о выпуске.
      expect(Object.keys(document.paths?.['/api/v1/graduates'] ?? {})).toStrictEqual(['get']);
      expect(Object.keys(document.paths?.['/api/v1/graduates/{id}'] ?? {}).sort()).toStrictEqual([
        'get',
        'put',
      ]);
      expect(
        Object.keys(document.paths?.['/api/v1/graduates/{id}/certificate'] ?? {}).sort(),
      ).toStrictEqual(['delete', 'post']);
    });

    it('выдача сертификата отвечает 201, а снятие — 200', () => {
      const document = buildOpenApiDocument(app);
      const certificate = document.paths?.['/api/v1/graduates/{id}/certificate'];

      expect(Object.keys(certificate?.post?.responses ?? {})).toContain('201');
      expect(Object.keys(certificate?.post?.responses ?? {})).not.toContain('200');
      expect(Object.keys(certificate?.delete?.responses ?? {})).toContain('200');
    });
  });
});
