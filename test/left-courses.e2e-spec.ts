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
import { AllExceptionsFilter, SortOrder, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { GroupStudentsModule } from 'src/group-students/group-students.module';
import type {
  CompetingMembership,
  GroupStudentRow,
  StudentGroup,
  StudentStatusUpdate,
} from 'src/group-students/group-students.repository';
import { GroupStudentsRepository } from 'src/group-students/group-students.repository';
import { LeftCourseSortField } from 'src/left-courses/dto';
import { LeftCoursesModule } from 'src/left-courses/left-courses.module';
import type {
  LeftCourseFactRow,
  LeftCourseFilter,
  LeftCourseListParams,
  LeftCourseRow,
} from 'src/left-courses/left-courses.repository';
import { LeftCoursesRepository } from 'src/left-courses/left-courses.repository';
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
}

interface StoredGroup {
  id: string;
  name: string;
  courseId: string;
  courseTitle: string;
  branchId: string;
  branchName: string;
}

interface StoredEmployee {
  id: string;
  firstName: string;
  lastName: string;
}

interface StoredMembership {
  groupId: string;
  studentId: string;
  status: GroupStudentStatus;
  statusReason: string | null;
  statusChangedAt: Date | null;
  enrolledAt: Date;
  mentorAtLeaveId: string | null;
}

/**
 * Студенты, группы, курсы, филиалы, менторство и членства **вместе** —
 * одно хранилище подставляется сразу на `GroupStudentsRepository`
 * и `LeftCoursesRepository`.
 *
 * Иначе главное свойство сессии проверить нечем: снимок «ментор на момент
 * ухода» пишет состав группы, а читает витрина покинувших, и два разведённых
 * хранилища проверяли бы каждое своё, а не то, что связывает их между собой.
 *
 * Отбор витрины здесь **повторяет правила репозитория** (только `LEFT`, срезы,
 * период, поиск по причине), а не подставляет готовые строки.
 */
class InMemoryStore {
  readonly students = new Map<string, StoredStudent>();
  readonly groups = new Map<string, StoredGroup>();
  readonly employees = new Map<string, StoredEmployee>();
  readonly memberships: StoredMembership[] = [];
  /** Ведущие менторы группы в порядке назначения. */
  readonly teachingMentors = new Map<string, string[]>();

  addStudent(lastName = 'Каримова', firstName = 'Нигина'): string {
    const id = randomUUID();
    this.students.set(id, {
      id,
      firstName,
      lastName,
      phone: `+99290${String(this.students.size).padStart(7, '0')}`,
      status: StudentStatus.ACTIVE,
    });

    return id;
  }

  addGroup(
    overrides: {
      name?: string;
      courseId?: string;
      courseTitle?: string;
      branchId?: string;
      branchName?: string;
    } = {},
  ): string {
    const id = randomUUID();
    this.groups.set(id, {
      id,
      name: overrides.name ?? 'Frontend-1',
      courseId: overrides.courseId ?? COURSE_ID,
      courseTitle: overrides.courseTitle ?? 'Frontend Basic',
      branchId: overrides.branchId ?? BRANCH_ID,
      branchName: overrides.branchName ?? 'Sadbarg',
    });

    return id;
  }

  addEmployee(lastName = 'Раҳимов', firstName = 'Фаррух'): string {
    const id = randomUUID();
    this.employees.set(id, { id, firstName, lastName });

    return id;
  }

  /** Назначение ведущего ментора: порядок списка = порядок `assignedAt`. */
  assignMentor(groupId: string, employeeId: string): void {
    this.teachingMentors.set(groupId, [...(this.teachingMentors.get(groupId) ?? []), employeeId]);
  }

  setMentors(groupId: string, employeeIds: string[]): void {
    this.teachingMentors.set(groupId, employeeIds);
  }

  enroll(groupId: string, studentId: string, enrolledAt = '2026-02-01'): void {
    this.memberships.push({
      groupId,
      studentId,
      status: GroupStudentStatus.ACTIVE,
      statusReason: null,
      statusChangedAt: null,
      enrolledAt: new Date(`${enrolledAt}T00:00:00.000Z`),
      mentorAtLeaveId: null,
    });
  }

  /** Закрытое членство прямо в хранилище — когда путь ухода не проверяется. */
  seedClosed(
    groupId: string,
    studentId: string,
    status: GroupStudentStatus,
    leftAt: string,
    reason = 'Переехал в другой город',
    mentorAtLeaveId: string | null = null,
  ): void {
    this.memberships.push({
      groupId,
      studentId,
      status,
      statusReason: reason,
      statusChangedAt: new Date(`${leftAt}T10:00:00.000Z`),
      enrolledAt: new Date('2026-02-01T00:00:00.000Z'),
      mentorAtLeaveId,
    });
  }

  membershipOf(groupId: string, studentId: string): StoredMembership | undefined {
    return this.memberships.find((m) => m.groupId === groupId && m.studentId === studentId);
  }

  // ─── GroupStudentsRepository ───

  findGroup(id: string): Promise<StudentGroup | null> {
    const group = this.groups.get(id);

    return Promise.resolve(
      group === undefined
        ? null
        : { id: group.id, name: group.name, courseId: group.courseId, capacity: 16 },
    );
  }

  findMemberships(groupId: string, studentIds: string[]): Promise<GroupStudentRow[]> {
    return Promise.resolve(
      this.memberships
        .filter((m) => m.groupId === groupId && studentIds.includes(m.studentId))
        .map((m) => this.toGroupStudentRow(m)),
    );
  }

  findCompetingMemberships(
    courseId: string,
    studentIds: string[],
    exceptGroupIds: string[],
  ): Promise<CompetingMembership[]> {
    return Promise.resolve(
      this.memberships
        .filter(
          (m) =>
            studentIds.includes(m.studentId) &&
            m.status === GroupStudentStatus.ACTIVE &&
            !exceptGroupIds.includes(m.groupId) &&
            this.groups.get(m.groupId)?.courseId === courseId,
        )
        .map((m) => ({
          studentId: m.studentId,
          groupId: m.groupId,
          group: { name: this.groups.get(m.groupId)?.name ?? '' },
          student: {
            firstName: this.students.get(m.studentId)?.firstName ?? '',
            lastName: this.students.get(m.studentId)?.lastName ?? '',
          },
        })),
    );
  }

  /** Ведущий ментор группы: назначенный раньше — тот, кто попадёт в снимок. */
  findLeaveMentor(groupId: string): Promise<string | null> {
    return Promise.resolve(this.teachingMentors.get(groupId)?.[0] ?? null);
  }

  countActive(groupId: string): Promise<number> {
    return Promise.resolve(
      this.memberships.filter(
        (m) => m.groupId === groupId && m.status === GroupStudentStatus.ACTIVE,
      ).length,
    );
  }

  changeStatus(
    groupId: string,
    studentIds: string[],
    status: GroupStudentStatus,
    reason: string,
    changedAt: Date,
    mentorAtLeaveId: string | null,
  ): Promise<GroupStudentRow[]> {
    const rows: GroupStudentRow[] = [];

    for (const membership of this.memberships) {
      if (membership.groupId !== groupId || !studentIds.includes(membership.studentId)) continue;

      membership.status = status;
      membership.statusReason = reason;
      membership.statusChangedAt = changedAt;
      membership.mentorAtLeaveId = mentorAtLeaveId;
      rows.push(this.toGroupStudentRow(membership));
    }

    return Promise.resolve(rows);
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

  // ─── LeftCoursesRepository ───

  findMany(params: LeftCourseListParams): Promise<{ rows: LeftCourseRow[]; total: number }> {
    const matched = this.memberships
      .filter((m) => this.matches(m, params))
      .map((m) => this.toLeftCourseRow(m));

    const sorted = [...matched].sort((a, b) => {
      const direction = params.order === SortOrder.Asc ? 1 : -1;
      if (params.sort === LeftCourseSortField.Name) {
        return (
          direction *
          (compare(a.student.lastName, b.student.lastName) ||
            compare(a.student.firstName, b.student.firstName))
        );
      }

      // Пустая дата всегда в конце — как `nulls: 'last'` в репозитории.
      if (a.statusChangedAt === null) return 1;
      if (b.statusChangedAt === null) return -1;

      return direction * (a.statusChangedAt.getTime() - b.statusChangedAt.getTime());
    });

    return Promise.resolve({
      rows: sorted.slice(params.skip, params.skip + params.take),
      total: sorted.length,
    });
  }

  findFacts(filter: LeftCourseFilter): Promise<LeftCourseFactRow[]> {
    return Promise.resolve(
      this.memberships
        .filter((m) => this.matches(m, filter))
        .map((m) => ({ statusChangedAt: m.statusChangedAt, group: this.groupOf(m.groupId) })),
    );
  }

  // ─── Правила выборки витрины (повторяют `whereOf` репозитория) ───

  private matches(membership: StoredMembership, filter: LeftCourseFilter): boolean {
    if (membership.status !== GroupStudentStatus.LEFT) return false;

    const group = this.groups.get(membership.groupId);
    if (filter.groupId !== undefined && membership.groupId !== filter.groupId) return false;
    if (filter.courseId !== undefined && group?.courseId !== filter.courseId) return false;
    if (filter.branchId !== undefined && group?.branchId !== filter.branchId) return false;

    const leftAt = membership.statusChangedAt;
    if (filter.from !== undefined && (leftAt === null || leftAt < filter.from)) return false;
    if (filter.to !== undefined && (leftAt === null || leftAt >= filter.to)) return false;

    if (filter.search !== undefined) {
      const needle = filter.search.toLowerCase();
      const student = this.students.get(membership.studentId);
      const haystack = [
        student?.firstName ?? '',
        student?.lastName ?? '',
        student?.phone ?? '',
        membership.statusReason ?? '',
      ].map((value) => value.toLowerCase());

      if (!haystack.some((value) => value.includes(needle))) return false;
    }

    return true;
  }

  private groupOf(groupId: string): LeftCourseRow['group'] {
    const group = this.groups.get(groupId);

    return {
      id: groupId,
      name: group?.name ?? '',
      course: { id: group?.courseId ?? '', title: group?.courseTitle ?? '' },
      branch: { id: group?.branchId ?? '', name: group?.branchName ?? '' },
    };
  }

  private toLeftCourseRow(membership: StoredMembership): LeftCourseRow {
    const student = this.students.get(membership.studentId);
    const mentor =
      membership.mentorAtLeaveId === null
        ? null
        : (this.employees.get(membership.mentorAtLeaveId) ?? null);

    return {
      groupId: membership.groupId,
      studentId: membership.studentId,
      statusReason: membership.statusReason,
      statusChangedAt: membership.statusChangedAt,
      enrolledAt: membership.enrolledAt,
      student: {
        id: membership.studentId,
        firstName: student?.firstName ?? '',
        lastName: student?.lastName ?? '',
        phone: student?.phone ?? '',
        photoUrl: null,
        status: student?.status ?? StudentStatus.ACTIVE,
      },
      group: this.groupOf(membership.groupId),
      mentorAtLeave: mentor,
    };
  }

  private toGroupStudentRow(membership: StoredMembership): GroupStudentRow {
    const student = this.students.get(membership.studentId);

    return {
      groupId: membership.groupId,
      studentId: membership.studentId,
      status: membership.status,
      statusReason: membership.statusReason,
      statusChangedAt: membership.statusChangedAt,
      enrolledAt: membership.enrolledAt,
      student: {
        id: membership.studentId,
        firstName: student?.firstName ?? '',
        lastName: student?.lastName ?? '',
        phone: student?.phone ?? '',
        photoUrl: null,
        status: student?.status ?? StudentStatus.ACTIVE,
      },
      transferredFromGroup: null,
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

interface LeftCourseItem {
  student: { id: string; lastName: string; status: StudentStatus };
  group: { id: string; name: string };
  course: { id: string; name: string };
  branch: { id: string; name: string };
  mentor: { id: string; lastName: string } | null;
  reason: string | null;
  leftAt: string | null;
  enrolledAt: string;
}

interface StatsBody {
  from: string;
  to: string;
  total: number;
  byMonth: { month: string; count: number }[];
  byGroup: { group: { id: string; name: string }; course: { name: string }; count: number }[];
  byCourse: { ref: { id: string; name: string }; count: number }[];
  byBranch: { ref: { id: string; name: string }; count: number }[];
}

describe('Покинувшие курсы (e2e, хранилище в памяти)', () => {
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
        LeftCoursesModule,
        // Состав группы поднимается вместе с витриной: именно он пишет снимок
        // «ментор на момент ухода», который витрина потом читает.
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
      .overrideProvider(LeftCoursesRepository)
      .useValue(store)
      .overrideProvider(GroupStudentsRepository)
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

  const actor = async (codes: string[]): Promise<string> => {
    const accountId = randomUUID();
    rbac.grant(accountId, codes);

    return (
      await tokens.issuePair({ sub: accountId, sid: randomUUID(), type: AccountType.EMPLOYEE })
    ).accessToken;
  };

  const viewer = () => actor(['Permission.LeftCourses.Views']);
  const operator = () =>
    actor(['Permission.LeftCourses.Views', 'Permission.Groups.ManageStudents']);

  const studentToken = async (): Promise<string> =>
    (await tokens.issuePair({ sub: randomUUID(), sid: randomUUID(), type: AccountType.STUDENT }))
      .accessToken;

  const get = (url: string, token: string) =>
    request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);

  const post = (url: string, token: string, body: object) =>
    request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${token}`).send(body);

  /** Уход через настоящий маршрут состава группы (ТЗ 5.5). */
  const leave = (
    token: string,
    groupId: string,
    studentIds: string[],
    reason = 'Переехал в другой город',
  ) =>
    post(`/api/v1/groups/${groupId}/students/change-status`, token, {
      studentIds,
      status: GroupStudentStatus.LEFT,
      reason,
    });

  describe('Доступ', () => {
    it('без токена — 401 на списке и на статистике', async () => {
      await request(app.getHttpServer()).get('/api/v1/left-courses').expect(401);
      await request(app.getHttpServer()).get('/api/v1/left-courses/stats').expect(401);
    });

    it('студенту витрина закрыта — 403', async () => {
      const token = await studentToken();

      await get('/api/v1/left-courses', token).expect(403);
      await get('/api/v1/left-courses/stats', token).expect(403);
    });

    it('сотрудник без прав — 403', async () => {
      await get('/api/v1/left-courses', await actor([])).expect(403);
    });

    it('право на состав групп витрину не открывает', async () => {
      const token = await actor(['Permission.Groups.ManageStudents', 'Permission.Groups.Views']);

      await get('/api/v1/left-courses', token).expect(403);
      await get('/api/v1/left-courses/stats', token).expect(403);
    });

    it('право на просмотр открывает и список, и статистику', async () => {
      const token = await viewer();

      await get('/api/v1/left-courses', token).expect(200);
      await get('/api/v1/left-courses/stats', token).expect(200);
    });
  });

  describe('Ментор на момент ухода (ТЗ 5.12)', () => {
    it('уход через состав группы фиксирует ведущего ментора, и он виден в витрине', async () => {
      const token = await operator();
      const groupId = store.addGroup();
      const mentorId = store.addEmployee('Раҳимов');
      const studentId = store.addStudent('Каримова');
      store.assignMentor(groupId, mentorId);
      store.enroll(groupId, studentId);

      await leave(token, groupId, [studentId]).expect(200);

      const rows = dataOf<LeftCourseItem[]>(await get('/api/v1/left-courses', token).expect(200));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        student: { id: studentId, lastName: 'Каримова', status: StudentStatus.NO_ACTIVE },
        group: { id: groupId, name: 'Frontend-1' },
        course: { name: 'Frontend Basic' },
        branch: { name: 'Sadbarg' },
        mentor: { id: mentorId, lastName: 'Раҳимов' },
        reason: 'Переехал в другой город',
      });
      expect(rows[0]?.leftAt).not.toBeNull();
    });

    // Главное свойство снимка: отчёт за прошлый месяц не переписывается
    // от того, что группе сменили преподавателя.
    it('смена состава менторов после ухода отчёт не меняет', async () => {
      const token = await operator();
      const groupId = store.addGroup();
      const first = store.addEmployee('Раҳимов');
      const second = store.addEmployee('Шарипов');
      const studentId = store.addStudent();
      store.assignMentor(groupId, first);
      store.enroll(groupId, studentId);

      await leave(token, groupId, [studentId]).expect(200);
      store.setMentors(groupId, [second]);

      const rows = dataOf<LeftCourseItem[]>(await get('/api/v1/left-courses', token).expect(200));
      expect(rows[0]?.mentor).toMatchObject({ id: first, lastName: 'Раҳимов' });
    });

    it('из нескольких ведущих в снимок идёт назначенный раньше', async () => {
      const token = await operator();
      const groupId = store.addGroup();
      const first = store.addEmployee('Раҳимов');
      store.addEmployee('Шарипов');
      const studentId = store.addStudent();
      store.assignMentor(groupId, first);
      store.assignMentor(groupId, store.addEmployee('Юсупов'));
      store.enroll(groupId, studentId);

      await leave(token, groupId, [studentId]).expect(200);

      expect(store.membershipOf(groupId, studentId)?.mentorAtLeaveId).toBe(first);
    });

    it('группа без ведущего ментора даёт mentor: null, а не догадку', async () => {
      const token = await operator();
      const groupId = store.addGroup();
      const studentId = store.addStudent();
      store.enroll(groupId, studentId);

      await leave(token, groupId, [studentId]).expect(200);

      const rows = dataOf<LeftCourseItem[]>(await get('/api/v1/left-courses', token).expect(200));
      expect(rows[0]?.mentor).toBeNull();
    });

    it('возврат студента в обучение убирает его из витрины и снимает снимок', async () => {
      const token = await operator();
      const groupId = store.addGroup();
      const mentorId = store.addEmployee();
      const studentId = store.addStudent();
      store.assignMentor(groupId, mentorId);
      store.enroll(groupId, studentId);

      await leave(token, groupId, [studentId]).expect(200);
      await post(`/api/v1/groups/${groupId}/students/change-status`, token, {
        studentIds: [studentId],
        status: GroupStudentStatus.ACTIVE,
        reason: 'Вернулся к учёбе',
      }).expect(200);

      expect(dataOf<LeftCourseItem[]>(await get('/api/v1/left-courses', token))).toEqual([]);
      expect(store.membershipOf(groupId, studentId)?.mentorAtLeaveId).toBeNull();
    });

    it('завершение курса в витрину не попадает и ментора не фиксирует', async () => {
      const token = await operator();
      const groupId = store.addGroup();
      store.assignMentor(groupId, store.addEmployee());
      const studentId = store.addStudent();
      store.enroll(groupId, studentId);

      await post(`/api/v1/groups/${groupId}/students/change-status`, token, {
        studentIds: [studentId],
        status: GroupStudentStatus.FINISHED,
        reason: 'Прошёл курс до конца',
      }).expect(200);

      expect(dataOf<LeftCourseItem[]>(await get('/api/v1/left-courses', token))).toEqual([]);
      expect(store.membershipOf(groupId, studentId)?.mentorAtLeaveId).toBeNull();
    });

    it('уход пачкой фиксирует одного и того же ментора всем', async () => {
      const token = await operator();
      const groupId = store.addGroup();
      const mentorId = store.addEmployee();
      const first = store.addStudent('Алиева');
      const second = store.addStudent('Бобоева');
      store.assignMentor(groupId, mentorId);
      store.enroll(groupId, first);
      store.enroll(groupId, second);

      await leave(token, groupId, [first, second]).expect(200);

      const rows = dataOf<LeftCourseItem[]>(await get('/api/v1/left-courses', token).expect(200));
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.mentor?.id === mentorId)).toBe(true);
    });
  });

  describe('Список покинувших', () => {
    it('переведённый в другую группу в отчёт по оттоку не попадает', async () => {
      const token = await viewer();
      const groupId = store.addGroup();
      const studentId = store.addStudent();
      store.seedClosed(groupId, studentId, GroupStudentStatus.TRANSFERRED, '2026-06-14');

      expect(dataOf<LeftCourseItem[]>(await get('/api/v1/left-courses', token))).toEqual([]);
    });

    // Строка отчёта — про покинутый курс, а не про человека: ушедший
    // с одного курса и продолжающий на другом обязан быть в оттоке.
    it('строка есть и у того, кто продолжает учиться на другом курсе', async () => {
      const token = await operator();
      const left = store.addGroup({ name: 'Frontend-1' });
      const kept = store.addGroup({ name: 'Python-1', courseId: OTHER_COURSE_ID });
      const studentId = store.addStudent();
      store.enroll(left, studentId);
      store.enroll(kept, studentId);

      await leave(token, left, [studentId]).expect(200);

      const rows = dataOf<LeftCourseItem[]>(await get('/api/v1/left-courses', token).expect(200));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        group: { name: 'Frontend-1' },
        student: { status: StudentStatus.ACTIVE },
      });
    });

    it('отдаёт `{ data, meta }` и режет страницами', async () => {
      const token = await viewer();
      const groupId = store.addGroup();
      for (const day of ['10', '11', '12']) {
        store.seedClosed(groupId, store.addStudent(), GroupStudentStatus.LEFT, `2026-06-${day}`);
      }

      const response = await get('/api/v1/left-courses?limit=2', token).expect(200);

      expect(dataOf<LeftCourseItem[]>(response)).toHaveLength(2);
      expect(metaOf<{ total: number; totalPages: number }>(response)).toMatchObject({
        total: 3,
        totalPages: 2,
      });
    });

    it('по умолчанию свежие уходы сверху, `order=asc` переворачивает', async () => {
      const token = await viewer();
      const groupId = store.addGroup();
      store.seedClosed(groupId, store.addStudent('Ранняя'), GroupStudentStatus.LEFT, '2026-04-10');
      store.seedClosed(groupId, store.addStudent('Поздняя'), GroupStudentStatus.LEFT, '2026-06-10');

      const desc = dataOf<LeftCourseItem[]>(await get('/api/v1/left-courses', token));
      expect(desc.map((row) => row.student.lastName)).toEqual(['Поздняя', 'Ранняя']);

      const asc = dataOf<LeftCourseItem[]>(await get('/api/v1/left-courses?order=asc', token));
      expect(asc.map((row) => row.student.lastName)).toEqual(['Ранняя', 'Поздняя']);
    });

    it('сортировка по имени идёт «фамилия, имя»', async () => {
      const token = await viewer();
      const groupId = store.addGroup();
      store.seedClosed(groupId, store.addStudent('Ямаева'), GroupStudentStatus.LEFT, '2026-06-10');
      store.seedClosed(groupId, store.addStudent('Алиева'), GroupStudentStatus.LEFT, '2026-06-11');

      const rows = dataOf<LeftCourseItem[]>(
        await get('/api/v1/left-courses?sort=name&order=asc', token).expect(200),
      );
      expect(rows.map((row) => row.student.lastName)).toEqual(['Алиева', 'Ямаева']);
    });

    it('фильтры по группе, курсу и филиалу', async () => {
      const token = await viewer();
      const frontend = store.addGroup({ name: 'Frontend-1' });
      const python = store.addGroup({
        name: 'Python-1',
        courseId: OTHER_COURSE_ID,
        courseTitle: 'Python Basic',
        branchId: OTHER_BRANCH_ID,
        branchName: 'Profsous',
      });
      store.seedClosed(
        frontend,
        store.addStudent('Фронтова'),
        GroupStudentStatus.LEFT,
        '2026-06-10',
      );
      store.seedClosed(python, store.addStudent('Питонова'), GroupStudentStatus.LEFT, '2026-06-11');

      const byGroup = dataOf<LeftCourseItem[]>(
        await get(`/api/v1/left-courses?groupId=${frontend}`, token).expect(200),
      );
      expect(byGroup.map((row) => row.student.lastName)).toEqual(['Фронтова']);

      const byCourse = dataOf<LeftCourseItem[]>(
        await get(`/api/v1/left-courses?courseId=${OTHER_COURSE_ID}`, token).expect(200),
      );
      expect(byCourse.map((row) => row.student.lastName)).toEqual(['Питонова']);

      const byBranch = dataOf<LeftCourseItem[]>(
        await get(`/api/v1/left-courses?branchId=${OTHER_BRANCH_ID}`, token).expect(200),
      );
      expect(byBranch.map((row) => row.student.lastName)).toEqual(['Питонова']);
    });

    it('период задаётся месяцами и включает обе границы', async () => {
      const token = await viewer();
      const groupId = store.addGroup();
      store.seedClosed(groupId, store.addStudent('Мартова'), GroupStudentStatus.LEFT, '2026-03-31');
      store.seedClosed(
        groupId,
        store.addStudent('Апрелева'),
        GroupStudentStatus.LEFT,
        '2026-04-01',
      );
      store.seedClosed(
        groupId,
        store.addStudent('Июньская'),
        GroupStudentStatus.LEFT,
        '2026-06-30',
      );
      store.seedClosed(groupId, store.addStudent('Июлева'), GroupStudentStatus.LEFT, '2026-07-01');

      const rows = dataOf<LeftCourseItem[]>(
        await get('/api/v1/left-courses?from=2026-04&to=2026-06&sort=name&order=asc', token).expect(
          200,
        ),
      );
      expect(rows.map((row) => row.student.lastName)).toEqual(['Апрелева', 'Июньская']);
    });

    // Причина — свободный текст, сгруппировать её нечем, поэтому поиск по ней
    // единственный способ ответить «кто ушёл из-за переезда».
    it('поиск идёт и по причине ухода, и по фамилии', async () => {
      const token = await viewer();
      const groupId = store.addGroup();
      store.seedClosed(
        groupId,
        store.addStudent('Каримова'),
        GroupStudentStatus.LEFT,
        '2026-06-10',
        'Переезд в другой город',
      );
      store.seedClosed(
        groupId,
        store.addStudent('Шарипова'),
        GroupStudentStatus.LEFT,
        '2026-06-11',
        'Нет времени',
      );

      const byReason = dataOf<LeftCourseItem[]>(
        await get('/api/v1/left-courses?search=переезд', token).expect(200),
      );
      expect(byReason.map((row) => row.student.lastName)).toEqual(['Каримова']);

      const byName = dataOf<LeftCourseItem[]>(
        await get('/api/v1/left-courses?search=шарипова', token).expect(200),
      );
      expect(byName.map((row) => row.student.lastName)).toEqual(['Шарипова']);
    });

    it('400 на негодный месяц, не-UUID в фильтре и неизвестное поле сортировки', async () => {
      const token = await viewer();

      await get('/api/v1/left-courses?from=2026-13', token).expect(400);
      await get('/api/v1/left-courses?to=2026-6', token).expect(400);
      await get('/api/v1/left-courses?groupId=not-a-uuid', token).expect(400);
      await get('/api/v1/left-courses?sort=reason', token).expect(400);
    });

    it('400 на начало периода позже конца', async () => {
      await get('/api/v1/left-courses?from=2026-06&to=2026-04', await viewer()).expect(400);
    });
  });

  describe('Статистика оттока', () => {
    it('строит помесячный ряд и три разреза', async () => {
      const token = await viewer();
      const frontend = store.addGroup({ name: 'Frontend-1' });
      const python = store.addGroup({
        name: 'Python-1',
        courseId: OTHER_COURSE_ID,
        courseTitle: 'Python Basic',
        branchId: OTHER_BRANCH_ID,
        branchName: 'Profsous',
      });
      store.seedClosed(frontend, store.addStudent(), GroupStudentStatus.LEFT, '2026-04-10');
      store.seedClosed(frontend, store.addStudent(), GroupStudentStatus.LEFT, '2026-06-10');
      store.seedClosed(python, store.addStudent(), GroupStudentStatus.LEFT, '2026-06-20');

      const stats = dataOf<StatsBody>(
        await get('/api/v1/left-courses/stats?from=2026-04&to=2026-06', token).expect(200),
      );

      expect(stats).toMatchObject({ from: '2026-04', to: '2026-06', total: 3 });
      expect(stats.byMonth).toEqual([
        { month: '2026-04', count: 1 },
        { month: '2026-05', count: 0 },
        { month: '2026-06', count: 2 },
      ]);
      expect(stats.byGroup).toMatchObject([
        {
          group: { id: frontend, name: 'Frontend-1' },
          course: { name: 'Frontend Basic' },
          count: 2,
        },
        { group: { id: python, name: 'Python-1' }, course: { name: 'Python Basic' }, count: 1 },
      ]);
      expect(stats.byCourse.map(({ count }) => count)).toEqual([2, 1]);
      expect(stats.byBranch).toEqual([
        { ref: { id: BRANCH_ID, name: 'Sadbarg' }, count: 2 },
        { ref: { id: OTHER_BRANCH_ID, name: 'Profsous' }, count: 1 },
      ]);
    });

    it('месяц без уходов остаётся столбцом с нулём', async () => {
      const stats = dataOf<StatsBody>(
        await get('/api/v1/left-courses/stats?from=2026-01&to=2026-03', await viewer()).expect(200),
      );

      expect(stats.total).toBe(0);
      expect(stats.byMonth).toEqual([
        { month: '2026-01', count: 0 },
        { month: '2026-02', count: 0 },
        { month: '2026-03', count: 0 },
      ]);
    });

    it('без параметров показывает двенадцать месяцев, заканчивая текущим', async () => {
      const stats = dataOf<StatsBody>(
        await get('/api/v1/left-courses/stats', await viewer()).expect(200),
      );

      expect(stats.byMonth).toHaveLength(12);
      expect(stats.byMonth.at(-1)?.month).toBe(stats.to);
      expect(stats.byMonth[0]?.month).toBe(stats.from);
    });

    it('разрезы статистики совпадают со списком по тем же фильтрам', async () => {
      const token = await viewer();
      const frontend = store.addGroup({ name: 'Frontend-1' });
      const python = store.addGroup({ name: 'Python-1', courseId: OTHER_COURSE_ID });
      store.seedClosed(frontend, store.addStudent(), GroupStudentStatus.LEFT, '2026-06-10');
      store.seedClosed(python, store.addStudent(), GroupStudentStatus.LEFT, '2026-06-11');

      const stats = dataOf<StatsBody>(
        await get(
          `/api/v1/left-courses/stats?from=2026-06&to=2026-06&groupId=${frontend}`,
          token,
        ).expect(200),
      );
      const list = metaOf<{ total: number }>(
        await get(`/api/v1/left-courses?from=2026-06&to=2026-06&groupId=${frontend}`, token).expect(
          200,
        ),
      );

      expect(stats.total).toBe(1);
      expect(stats.total).toBe(list.total);
    });

    it('переведённые и завершившие в статистику не идут', async () => {
      const token = await viewer();
      const groupId = store.addGroup();
      store.seedClosed(groupId, store.addStudent(), GroupStudentStatus.LEFT, '2026-06-10');
      store.seedClosed(groupId, store.addStudent(), GroupStudentStatus.TRANSFERRED, '2026-06-11');
      store.seedClosed(groupId, store.addStudent(), GroupStudentStatus.FINISHED, '2026-06-12');

      const stats = dataOf<StatsBody>(
        await get('/api/v1/left-courses/stats?from=2026-06&to=2026-06', token).expect(200),
      );

      expect(stats.total).toBe(1);
    });

    it('400 на слишком длинный период', async () => {
      await get('/api/v1/left-courses/stats?from=2000-01&to=2026-06', await viewer()).expect(400);
    });

    it('400 на негодный месяц и на перевёрнутый период', async () => {
      const token = await viewer();

      await get('/api/v1/left-courses/stats?to=2026-00', token).expect(400);
      await get('/api/v1/left-courses/stats?from=2026-06&to=2026-04', token).expect(400);
    });
  });

  describe('OpenAPI', () => {
    it('оба пути в документе, и у каждого описан только get', () => {
      const document = buildOpenApiDocument(app);

      // Витрина только читает: уход оформляется составом группы, и второго
      // способа «отчислить» в документе быть не должно.
      expect(Object.keys(document.paths?.['/api/v1/left-courses'] ?? {})).toStrictEqual(['get']);
      expect(Object.keys(document.paths?.['/api/v1/left-courses/stats'] ?? {})).toStrictEqual([
        'get',
      ]);
    });
  });
});
