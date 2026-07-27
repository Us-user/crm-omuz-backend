import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  AccountType,
  AttendanceMark,
  DurationUnit,
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
import { AllExceptionsFilter, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import type { GroupActivityRows, GroupListParams, GroupRow } from 'src/groups/groups.repository';
import { GroupsRepository } from 'src/groups/groups.repository';
import { GroupsModule } from 'src/groups/groups.module';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { ActivityCategory } from 'src/performance/performance';
import { PerformanceModule } from 'src/performance/performance.module';
import type {
  AttendanceTally,
  RankedAverage,
  StudentMembershipRow,
  StudentWeekResultRow,
} from 'src/performance/performance.repository';
import { PerformanceRepository } from 'src/performance/performance.repository';
import { PhoneModule } from 'src/phone/phone.module';
import { RbacModule } from 'src/rbac/rbac.module';
import { RbacRepository } from 'src/rbac/rbac.repository';
import type {
  StudentListParams,
  StudentRow,
  StudentScoreRow,
} from 'src/students/students.repository';
import { StudentsRepository } from 'src/students/students.repository';
import { StudentsModule } from 'src/students/students.module';
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

interface StoredStudent {
  id: string;
  firstName: string;
  lastName: string;
}

interface StoredGroup {
  id: string;
  name: string;
  courseId: string;
  courseTitle: string;
}

interface StoredMembership {
  groupId: string;
  studentId: string;
  status: GroupStudentStatus;
}

interface StoredWeek {
  id: string;
  groupId: string;
  weekNumber: number;
  startDate: Date;
  submittedAt: Date | null;
}

interface StoredResult {
  weekId: string;
  studentId: string;
  bonus: number;
  exam: number;
  sum: number;
}

const COURSE_ID = '44444444-4444-4444-4444-444444444444';
const BRANCH_ID = '55555555-5555-5555-5555-555555555555';

/**
 * Студенты, группы, членства, недели журнала и их итоги вместе.
 *
 * Хранилище **повторяет правила выборки**, а не подставляет готовые числа:
 * общий балл считается только по финализированным неделям, а в рейтинг идут
 * только студенты с действующим членством. Разведённые заглушки проверяли бы
 * не те решения, ради которых сессия и делалась.
 */
class InMemoryPerformanceStore {
  readonly students = new Map<string, StoredStudent>();
  readonly groups = new Map<string, StoredGroup>();
  readonly memberships: StoredMembership[] = [];
  readonly weeks = new Map<string, StoredWeek>();
  readonly results: StoredResult[] = [];
  readonly attendance: { studentId: string; mark: AttendanceMark }[] = [];

  addStudent(lastName = 'Каримова', firstName = 'Нигина'): string {
    const id = randomUUID();
    this.students.set(id, { id, firstName, lastName });

    return id;
  }

  addGroup(name = 'Frontend-1', courseTitle = 'Frontend Basic'): string {
    const id = randomUUID();
    this.groups.set(id, { id, name, courseId: COURSE_ID, courseTitle });

    return id;
  }

  enroll(
    groupId: string,
    studentId: string,
    status: GroupStudentStatus = GroupStudentStatus.ACTIVE,
  ): void {
    this.memberships.push({ groupId, studentId, status });
  }

  /** Неделя журнала. `submitted: false` — открытая: в общий балл она не входит. */
  addWeek(groupId: string, weekNumber: number, submitted = true): string {
    const id = randomUUID();
    this.weeks.set(id, {
      id,
      groupId,
      weekNumber,
      startDate: new Date(`2026-09-0${String(weekNumber)}T00:00:00.000Z`),
      submittedAt: submitted ? new Date('2026-09-14T09:00:00.000Z') : null,
    });

    return id;
  }

  addResult(weekId: string, studentId: string, sum: number, bonus = 0, exam = 0): void {
    this.results.push({ weekId, studentId, bonus, exam, sum });
  }

  mark(studentId: string, mark: AttendanceMark, times = 1): void {
    for (let i = 0; i < times; i += 1) this.attendance.push({ studentId, mark });
  }

  // ─── Общие правила выборки ───

  private finalizedResultsOf(studentId: string): StoredResult[] {
    return this.results.filter(
      (result) =>
        result.studentId === studentId && this.weeks.get(result.weekId)?.submittedAt !== null,
    );
  }

  private averageOf(sums: number[]): number | null {
    return sums.length === 0 ? null : sums.reduce((total, sum) => total + sum, 0) / sums.length;
  }

  private isStudying(studentId: string): boolean {
    return this.memberships.some(
      (m) => m.studentId === studentId && m.status === GroupStudentStatus.ACTIVE,
    );
  }

  // ─── PerformanceRepository ───

  findStudent(id: string): Promise<StoredStudent | null> {
    return Promise.resolve(this.students.get(id) ?? null);
  }

  findFinalizedResults(studentId: string): Promise<StudentWeekResultRow[]> {
    const rows = this.finalizedResultsOf(studentId).map((result) => {
      const week = this.weeks.get(result.weekId);

      return {
        sum: result.sum,
        bonus: result.bonus,
        exam: result.exam,
        week: {
          id: week?.id ?? '',
          weekNumber: week?.weekNumber ?? 0,
          startDate: week?.startDate ?? new Date(0),
          submittedAt: week?.submittedAt ?? null,
          groupId: week?.groupId ?? '',
        },
      };
    });

    return Promise.resolve(
      rows.sort((a, b) => b.week.startDate.getTime() - a.week.startDate.getTime()),
    );
  }

  findMemberships(studentId: string): Promise<StudentMembershipRow[]> {
    return Promise.resolve(
      this.memberships
        .filter((m) => m.studentId === studentId)
        .map((m) => {
          const group = this.groups.get(m.groupId);

          return {
            status: m.status,
            group: {
              id: m.groupId,
              name: group?.name ?? '',
              course: { id: COURSE_ID, title: group?.courseTitle ?? '' },
              branch: { id: BRANCH_ID, name: 'Sadbarg' },
            },
          };
        }),
    );
  }

  aggregateAttendance(studentId: string): Promise<AttendanceTally[]> {
    const counts = new Map<AttendanceMark, number>();
    for (const entry of this.attendance) {
      if (entry.studentId !== studentId) continue;
      counts.set(entry.mark, (counts.get(entry.mark) ?? 0) + 1);
    }

    return Promise.resolve([...counts].map(([attendance, count]) => ({ attendance, count })));
  }

  findRankedAverages(): Promise<RankedAverage[]> {
    return Promise.resolve(
      [...this.students.keys()].flatMap((studentId) => {
        if (!this.isStudying(studentId)) return [];
        const average = this.averageOf(this.finalizedResultsOf(studentId).map(({ sum }) => sum));

        return average === null ? [] : [{ studentId, average }];
      }),
    );
  }

  // ─── StudentsRepository ───

  aggregateScores(studentIds: string[]): Promise<StudentScoreRow[]> {
    return Promise.resolve(
      studentIds.flatMap((studentId) => {
        const sums = this.finalizedResultsOf(studentId).map(({ sum }) => sum);
        const average = this.averageOf(sums);

        return average === null ? [] : [{ studentId, average, weeksCount: sums.length }];
      }),
    );
  }

  async findTopAverage(): Promise<number | null> {
    const ranked = await this.findRankedAverages();

    return ranked.length === 0 ? null : Math.max(...ranked.map(({ average }) => average));
  }

  private studentRow(student: StoredStudent): StudentRow {
    const active = this.memberships.filter(
      (m) => m.studentId === student.id && m.status === GroupStudentStatus.ACTIVE,
    );

    return {
      id: student.id,
      firstName: student.firstName,
      lastName: student.lastName,
      phone: `+99290${student.id.slice(0, 7).replace(/\D/g, '0').padEnd(7, '0')}`,
      birthDate: null,
      gender: null,
      address: null,
      email: null,
      extraPhones: [],
      telegram: null,
      photoUrl: null,
      notes: null,
      status: StudentStatus.ACTIVE,
      createdAt: new Date('2026-07-27T10:00:00.000Z'),
      branch: null,
      parents: [],
      account: null,
      groups: active.map((m) => ({
        group: {
          id: m.groupId,
          name: this.groups.get(m.groupId)?.name ?? '',
          courseId: COURSE_ID,
          course: { title: this.groups.get(m.groupId)?.courseTitle ?? '' },
        },
      })),
      _count: { groups: this.memberships.filter((m) => m.studentId === student.id).length },
    };
  }

  findStudents(params: StudentListParams): Promise<{ rows: StudentRow[]; total: number }> {
    const rows = [...this.students.values()]
      .sort((a, b) => a.lastName.localeCompare(b.lastName))
      .map((student) => this.studentRow(student));

    return Promise.resolve({
      rows: rows.slice(params.skip, params.skip + params.take),
      total: rows.length,
    });
  }

  findStudentById(id: string): Promise<StudentRow | null> {
    const student = this.students.get(id);

    return Promise.resolve(student ? this.studentRow(student) : null);
  }

  // ─── GroupsRepository ───

  private groupRow(group: StoredGroup): GroupRow {
    return {
      id: group.id,
      name: group.name,
      description: null,
      course: { id: group.courseId, title: group.courseTitle, isLastCourse: false },
      branch: { id: BRANCH_ID, name: 'Sadbarg' },
      format: GroupFormat.OFFLINE,
      startDate: null,
      endDate: null,
      durationValue: null,
      durationUnit: DurationUnit.MONTH,
      capacity: 16,
      status: GroupStatus.ACTIVE,
      telegramUrl: null,
      createdAt: new Date('2026-07-27T10:00:00.000Z'),
      _count: {
        students: this.memberships.filter(
          (m) => m.groupId === group.id && m.status === GroupStudentStatus.ACTIVE,
        ).length,
      },
    };
  }

  findGroups(params: GroupListParams): Promise<{ rows: GroupRow[]; total: number }> {
    const rows = [...this.groups.values()].map((group) => this.groupRow(group));

    return Promise.resolve({
      rows: rows.slice(params.skip, params.skip + params.take),
      total: rows.length,
    });
  }

  findGroupById(id: string): Promise<GroupRow | null> {
    const group = this.groups.get(id);

    return Promise.resolve(group ? this.groupRow(group) : null);
  }

  findActivity(groupIds: string[]): Promise<GroupActivityRows> {
    return Promise.resolve({
      members: this.memberships
        .filter((m) => groupIds.includes(m.groupId) && m.status === GroupStudentStatus.ACTIVE)
        .map(({ groupId, studentId }) => ({ groupId, studentId })),
      results: this.results.flatMap((result) => {
        const week = this.weeks.get(result.weekId);
        if (!week || week.submittedAt === null || !groupIds.includes(week.groupId)) return [];

        return [{ groupId: week.groupId, studentId: result.studentId, sum: result.sum }];
      }),
    });
  }
}

interface PerformanceBody {
  student: { id: string; firstName: string; lastName: string };
  averageScore: number | null;
  category: ActivityCategory | null;
  categoryTitle: string | null;
  passing: boolean;
  weeksCount: number;
  rank: {
    position: number | null;
    totalRanked: number;
    isTopStudent: boolean;
    ranked: boolean;
  };
  attendance: {
    present: number;
    late: number;
    absent: number;
    marked: number;
    attendanceRate: number | null;
  };
  groups: {
    groupId: string;
    groupName: string | null;
    averageScore: number | null;
    category: ActivityCategory | null;
    weeksCount: number;
  }[];
  weeks: { weekNumber: number; groupName: string | null; sum: number; startDate: string }[];
}

interface StudentListItem {
  id: string;
  lastName: string;
  averageScore: number | null;
  activityCategory: ActivityCategory | null;
  activityCategoryTitle: string | null;
  isTopStudent: boolean;
}

interface GroupListItem {
  id: string;
  enrolledCount: number;
  passingCount: number;
  activity: {
    chatGpt: number;
    handsome: number;
    advanced: number;
    kettle: number;
    blackList: number;
    unscored: number;
  };
}

describe('Успеваемость, категории и корона (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryPerformanceStore;
  let rbac: InMemoryRbacRepository;
  let tokens: TokenService;

  beforeEach(async () => {
    store = new InMemoryPerformanceStore();
    rbac = new InMemoryRbacRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        PhoneModule,
        AuthModule,
        RbacModule,
        PerformanceModule,
        // Соседние модули: корона и категория стоят в строке списка студентов,
        // а счётчики категорий — в строке списка групп. Одно хранилище на три
        // репозитория: иначе балл в витрине и балл в списке разошлись бы.
        StudentsModule,
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
      .overrideProvider(PerformanceRepository)
      .useValue(store)
      .overrideProvider(StudentsRepository)
      .useValue({
        findMany: (params: StudentListParams) => store.findStudents(params),
        findById: (id: string) => store.findStudentById(id),
        aggregateScores: (ids: string[]) => store.aggregateScores(ids),
        findTopAverage: () => store.findTopAverage(),
      })
      .overrideProvider(GroupsRepository)
      .useValue({
        findMany: (params: GroupListParams) => store.findGroups(params),
        findById: (id: string) => store.findGroupById(id),
        findActivity: (ids: string[]) => store.findActivity(ids),
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

  const actor = async (codes: string[]): Promise<string> => {
    const accountId = randomUUID();
    rbac.grant(accountId, codes);

    return (
      await tokens.issuePair({ sub: accountId, sid: randomUUID(), type: AccountType.EMPLOYEE })
    ).accessToken;
  };

  const studentToken = async (): Promise<string> =>
    (await tokens.issuePair({ sub: randomUUID(), sid: randomUUID(), type: AccountType.STUDENT }))
      .accessToken;

  const get = (url: string, token: string) =>
    request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);

  const performanceUrl = (studentId: string) => `/api/v1/students/${studentId}/performance`;

  /** Студент в группе с одной закрытой неделей на каждый переданный итог. */
  const studentWithSums = (
    sums: number[],
    lastName = 'Каримова',
  ): { id: string; groupId: string } => {
    const id = store.addStudent(lastName);
    const groupId = store.addGroup(`Group-${lastName}`);
    store.enroll(groupId, id);
    sums.forEach((sum, index) => {
      const weekId = store.addWeek(groupId, index + 1);
      store.addResult(weekId, id, sum);
    });

    return { id, groupId };
  };

  describe('Доступ', () => {
    it('без токена — 401', async () => {
      await request(app.getHttpServer()).get(performanceUrl(store.addStudent())).expect(401);
    });

    it('студент чужую успеваемость не читает — 403 (ТЗ 3.2)', async () => {
      await get(performanceUrl(store.addStudent()), await studentToken()).expect(403);
    });

    it('сотрудник без прав — 403', async () => {
      await get(performanceUrl(store.addStudent()), await actor([])).expect(403);
    });

    it('право на журнал успеваемость не открывает', async () => {
      await get(
        performanceUrl(store.addStudent()),
        await actor(['Permission.Journal.Views']),
      ).expect(403);
    });

    it('404 на неизвестного студента и 400 на не-UUID в пути', async () => {
      const token = await actor(['Permission.Students.Views']);

      await get(performanceUrl(randomUUID()), token).expect(404);
      await get('/api/v1/students/not-a-uuid/performance', token).expect(400);
    });
  });

  describe('Общий балл (ТЗ 5.8)', () => {
    it('среднее Sum по закрытым неделям с категорией из ТЗ 5.5', async () => {
      const { id } = studentWithSums([100, 90, 80]);

      const body = dataOf<PerformanceBody>(
        await get(performanceUrl(id), await actor(['Permission.Students.Views'])).expect(200),
      );

      expect(body).toMatchObject({
        averageScore: 90,
        category: ActivityCategory.Handsome,
        categoryTitle: 'Handsome',
        passing: true,
        weeksCount: 3,
      });
    });

    it('ОТКРЫТАЯ неделя в общий балл не входит', async () => {
      // Ключевое решение сессии 0019: неделя заводится с нулевыми итогами
      // на весь состав, и учёт открытых недель обрушивал бы балл
      // каждый понедельник.
      const id = store.addStudent();
      const groupId = store.addGroup();
      store.enroll(groupId, id);

      const closed = store.addWeek(groupId, 1, true);
      store.addResult(closed, id, 100);
      const open = store.addWeek(groupId, 2, false);
      store.addResult(open, id, 0);

      const body = dataOf<PerformanceBody>(
        await get(performanceUrl(id), await actor(['Permission.Students.Views'])).expect(200),
      );

      expect(body.averageScore).toBe(100);
      expect(body.weeksCount).toBe(1);
      expect(body.weeks).toHaveLength(1);
    });

    it('без закрытых недель балла нет — null, а не ноль', async () => {
      const id = store.addStudent();
      const groupId = store.addGroup();
      store.enroll(groupId, id);

      const body = dataOf<PerformanceBody>(
        await get(performanceUrl(id), await actor(['Permission.Students.Views'])).expect(200),
      );

      expect(body).toMatchObject({
        averageScore: null,
        category: null,
        categoryTitle: null,
        passing: false,
        weeksCount: 0,
      });
    });

    it('балл ниже 45 даёт Black list и не считается успевающим', async () => {
      const { id } = studentWithSums([40, 30]);

      const body = dataOf<PerformanceBody>(
        await get(performanceUrl(id), await actor(['Permission.Students.Views'])).expect(200),
      );

      expect(body).toMatchObject({ category: ActivityCategory.BlackList, passing: false });
    });
  });

  describe('Рейтинг и корона (ТЗ 5.3, 5.13)', () => {
    it('расставляет места и коронует первого', async () => {
      const first = studentWithSums([100], 'Алиев');
      const second = studentWithSums([80], 'Бобоев');
      const token = await actor(['Permission.Students.Views']);

      const top = dataOf<PerformanceBody>(await get(performanceUrl(first.id), token).expect(200));
      const next = dataOf<PerformanceBody>(await get(performanceUrl(second.id), token).expect(200));

      expect(top.rank).toStrictEqual({
        position: 1,
        totalRanked: 2,
        isTopStudent: true,
        ranked: true,
      });
      expect(next.rank).toMatchObject({ position: 2, isTopStudent: false, ranked: true });
    });

    it('выпускник в рейтинге не участвует, но балл у него остаётся', async () => {
      // Решение сессии 0019: иначе корона навсегда осталась бы у него.
      const id = store.addStudent('Выпускников');
      const groupId = store.addGroup('Прошлый поток');
      store.enroll(groupId, id, GroupStudentStatus.FINISHED);
      const weekId = store.addWeek(groupId, 1);
      store.addResult(weekId, id, 100);

      const learner = studentWithSums([60], 'Учащийся');
      const token = await actor(['Permission.Students.Views']);

      const graduate = dataOf<PerformanceBody>(await get(performanceUrl(id), token).expect(200));
      const active = dataOf<PerformanceBody>(
        await get(performanceUrl(learner.id), token).expect(200),
      );

      expect(graduate.averageScore).toBe(100);
      expect(graduate.rank).toMatchObject({ position: null, isTopStudent: false, ranked: false });
      // Корона достаётся тому, кто учится, даже с меньшим баллом.
      expect(active.rank).toMatchObject({ position: 1, isTopStudent: true });
    });

    it('при равенстве баллов корона у обоих', async () => {
      const one = studentWithSums([90], 'Алиев');
      const two = studentWithSums([90], 'Бобоев');
      const token = await actor(['Permission.Students.Views']);

      for (const student of [one, two]) {
        const body = dataOf<PerformanceBody>(
          await get(performanceUrl(student.id), token).expect(200),
        );
        expect(body.rank).toMatchObject({ position: 1, totalRanked: 2, isTopStudent: true });
      }
    });
  });

  describe('Посещаемость и разрез по группам', () => {
    it('считает отметки, а опоздание относит к приходам (ТЗ 5.8)', async () => {
      const { id } = studentWithSums([90]);
      store.mark(id, AttendanceMark.PRESENT, 8);
      store.mark(id, AttendanceMark.LATE, 2);
      store.mark(id, AttendanceMark.ABSENT, 2);

      const body = dataOf<PerformanceBody>(
        await get(performanceUrl(id), await actor(['Permission.Students.Views'])).expect(200),
      );

      expect(body.attendance).toStrictEqual({
        present: 8,
        late: 2,
        absent: 2,
        marked: 12,
        attendanceRate: 83.33,
      });
    });

    it('балл каждой группы считается отдельно от общего', async () => {
      const id = store.addStudent();
      const frontend = store.addGroup('Frontend-1', 'Frontend Basic');
      const python = store.addGroup('Python-1', 'Python Basic');
      store.enroll(frontend, id);
      store.enroll(python, id);
      store.addResult(store.addWeek(frontend, 1), id, 100);
      store.addResult(store.addWeek(frontend, 2), id, 90);
      store.addResult(store.addWeek(python, 3), id, 50);

      const body = dataOf<PerformanceBody>(
        await get(performanceUrl(id), await actor(['Permission.Students.Views'])).expect(200),
      );

      expect(body.averageScore).toBe(80);
      expect(body.groups).toStrictEqual([
        expect.objectContaining({ groupId: frontend, averageScore: 95, weeksCount: 2 }),
        expect.objectContaining({ groupId: python, averageScore: 50, weeksCount: 1 }),
      ]);
    });

    it('группа без закрытых недель остаётся в разрезе с баллом null', async () => {
      const id = store.addStudent();
      const groupId = store.addGroup();
      store.enroll(groupId, id);
      store.addWeek(groupId, 1, false);

      const body = dataOf<PerformanceBody>(
        await get(performanceUrl(id), await actor(['Permission.Students.Views'])).expect(200),
      );

      expect(body.groups).toStrictEqual([
        expect.objectContaining({ groupId, averageScore: null, category: null, weeksCount: 0 }),
      ]);
    });
  });

  describe('Корона и категория в списке студентов (ТЗ 5.3)', () => {
    it('строка списка несёт балл, категорию и корону', async () => {
      studentWithSums([100], 'Алиев');
      studentWithSums([50], 'Бобоев');

      const response = await get(
        '/api/v1/students',
        await actor(['Permission.Students.Views']),
      ).expect(200);
      const items = dataOf<StudentListItem[]>(response);

      expect(items).toStrictEqual([
        expect.objectContaining({
          lastName: 'Алиев',
          averageScore: 100,
          activityCategory: ActivityCategory.ChatGpt,
          activityCategoryTitle: 'ChatGPT',
          isTopStudent: true,
        }),
        expect.objectContaining({
          lastName: 'Бобоев',
          averageScore: 50,
          activityCategory: ActivityCategory.Kettle,
          isTopStudent: false,
        }),
      ]);
    });

    it('студент без закрытых недель идёт с пустым баллом и без короны', async () => {
      store.addStudent('Новенькая');

      const items = dataOf<StudentListItem[]>(
        await get('/api/v1/students', await actor(['Permission.Students.Views'])).expect(200),
      );

      expect(items[0]).toMatchObject({
        averageScore: null,
        activityCategory: null,
        isTopStudent: false,
      });
    });

    it('карточка студента отдаёт те же балл и категорию, что и витрина', async () => {
      const { id } = studentWithSums([96, 98]);
      const token = await actor(['Permission.Students.Views']);

      const card = dataOf<StudentListItem>(await get(`/api/v1/students/${id}`, token).expect(200));
      const performance = dataOf<PerformanceBody>(await get(performanceUrl(id), token).expect(200));

      expect(card.averageScore).toBe(97);
      expect(card.averageScore).toBe(performance.averageScore);
      expect(card.activityCategory).toBe(performance.category);
    });
  });

  describe('Счётчики категорий и Passing students в группах (ТЗ 5.5)', () => {
    it('раскладывает действующий состав по категориям', async () => {
      const groupId = store.addGroup();
      const week = store.addWeek(groupId, 1);
      const chatGpt = store.addStudent('Алиев');
      const kettle = store.addStudent('Бобоев');
      const blackList = store.addStudent('Валиев');
      const unscored = store.addStudent('Ганиев');

      for (const id of [chatGpt, kettle, blackList, unscored]) store.enroll(groupId, id);
      store.addResult(week, chatGpt, 100);
      store.addResult(week, kettle, 50);
      store.addResult(week, blackList, 20);

      const items = dataOf<GroupListItem[]>(
        await get('/api/v1/groups', await actor(['Permission.Groups.Views'])).expect(200),
      );

      expect(items[0]?.activity).toStrictEqual({
        chatGpt: 1,
        handsome: 0,
        advanced: 0,
        kettle: 1,
        blackList: 1,
        unscored: 1,
      });
      // Успевают те, кто не в Black list: ChatGPT и Kettle. Не оценённый не считается.
      expect(items[0]?.passingCount).toBe(2);
      expect(items[0]?.enrolledCount).toBe(4);
    });

    it('открытая неделя счётчики не двигает', async () => {
      const groupId = store.addGroup();
      const id = store.addStudent();
      store.enroll(groupId, id);
      store.addResult(store.addWeek(groupId, 1, false), id, 0);

      const group = dataOf<GroupListItem>(
        await get(`/api/v1/groups/${groupId}`, await actor(['Permission.Groups.Views'])).expect(
          200,
        ),
      );

      // Ноль из открытой недели записал бы студента в Black list.
      expect(group.activity.unscored).toBe(1);
      expect(group.activity.blackList).toBe(0);
    });

    it('покинувший группу в её счётчики не входит', async () => {
      const groupId = store.addGroup();
      const left = store.addStudent('Ушедший');
      store.enroll(groupId, left, GroupStudentStatus.LEFT);
      store.addResult(store.addWeek(groupId, 1), left, 100);

      const group = dataOf<GroupListItem>(
        await get(`/api/v1/groups/${groupId}`, await actor(['Permission.Groups.Views'])).expect(
          200,
        ),
      );

      expect(group.activity.chatGpt).toBe(0);
      expect(group.passingCount).toBe(0);
      expect(group.enrolledCount).toBe(0);
    });

    it('пустая группа отдаёт нули, а не пропускает счётчики', async () => {
      const groupId = store.addGroup();

      const group = dataOf<GroupListItem>(
        await get(`/api/v1/groups/${groupId}`, await actor(['Permission.Groups.Views'])).expect(
          200,
        ),
      );

      expect(group.activity).toStrictEqual({
        chatGpt: 0,
        handsome: 0,
        advanced: 0,
        kettle: 0,
        blackList: 0,
        unscored: 0,
      });
      expect(group.passingCount).toBe(0);
    });

    it('балл группы считается по её неделям, а не по соседнему курсу', async () => {
      const frontend = store.addGroup('Frontend-1');
      const python = store.addGroup('Python-1');
      const id = store.addStudent();
      store.enroll(frontend, id);
      store.enroll(python, id);
      store.addResult(store.addWeek(frontend, 1), id, 100);
      store.addResult(store.addWeek(python, 2), id, 10);

      const items = dataOf<GroupListItem[]>(
        await get('/api/v1/groups', await actor(['Permission.Groups.Views'])).expect(200),
      );

      const frontendRow = items.find((item) => item.id === frontend);
      const pythonRow = items.find((item) => item.id === python);

      expect(frontendRow?.activity.chatGpt).toBe(1);
      expect(pythonRow?.activity.blackList).toBe(1);
    });
  });

  it('OpenAPI описывает витрину успеваемости', () => {
    const document = buildOpenApiDocument(app);

    expect(document.paths?.['/api/v1/students/{studentId}/performance']).toBeDefined();
    // Витрина только читается: ни создания, ни правки у неё нет.
    expect(
      Object.keys(document.paths?.['/api/v1/students/{studentId}/performance'] ?? {}),
    ).toStrictEqual(['get']);
  });
});
