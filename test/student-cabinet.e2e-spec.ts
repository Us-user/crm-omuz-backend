import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  AccountType,
  AttendanceMark,
  Gender,
  GroupFormat,
  GroupMentorRole,
  GroupStatus,
  GroupStudentStatus,
  ParentRelation,
  StudentStatus,
  WeekDay,
} from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, SortOrder, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { ActivityCategory } from 'src/performance/performance';
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
import { MeGroupSortField, MeScheduleSortField } from 'src/student-cabinet/dto';
import { StudentCabinetModule } from 'src/student-cabinet/student-cabinet.module';
import type {
  MeMembershipListParams,
  MeMembershipRow,
  MeProfileRow,
  MeScheduleListParams,
  MeSlotRow,
} from 'src/student-cabinet/student-cabinet.repository';
import { StudentCabinetRepository } from 'src/student-cabinet/student-cabinet.repository';
import { buildOpenApiDocument } from 'src/swagger';

/** `{ data }` ответа с ожидаемым типом — тела supertest типизированы как `any`. */
const dataOf = <T>(response: { body: unknown }): T => (response.body as { data: T }).data;

/** Порядок дней недели даёт сам тип: в PostgreSQL он сортируется по объявлению. */
const WEEK_DAYS = Object.values(WeekDay);

type StoredGroup = MeMembershipRow['group'];
type StoredMembership = MeMembershipRow & { studentId: string };
type StoredSlot = MeSlotRow & { groupId: string };

/** Неделя журнала: в общий балл идут только финализированные (решение сессии 0019). */
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

/**
 * Права аккаунта в памяти вместо трёх таблиц RBAC (как в остальных наборах).
 *
 * Кабинету они не нужны — у студента прав нет по определению (ТЗ 3.2). Но вместе
 * с `PerformanceModule` в приложение приезжает и его контроллер
 * `GET /students/{id}/performance`, а тот закрыт правом каталога: без `RbacModule`
 * приложение просто не собралось бы. Заодно это даёт то, ради чего кабинет
 * и переиспользует расчёт, — возможность сравнить оба ответа в одном наборе.
 */
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

interface StudentSeed {
  accountId?: string;
  status?: StudentStatus;
  firstName?: string;
  lastName?: string;
}

/**
 * Студенты, их членства, группы, занятия, недели журнала и итоги — вместе.
 *
 * Иначе главные свойства кабинета проверить нечем: расписание отбирается
 * **через действующие членства**, а не по списку групп, а балл — через
 * финализированные недели тех же групп. Несогласованные заглушки показали бы
 * не то поведение, которое даёт БД.
 *
 * Один и тот же объект подставляется и на `StudentCabinetRepository`,
 * и на `PerformanceRepository`: два хранилища могли бы разойтись ровно в том,
 * ради чего кабинет и переиспользует расчёт.
 */
class InMemoryCabinetStore {
  readonly studentsByAccount = new Map<string, MeProfileRow>();
  readonly memberships: StoredMembership[] = [];
  readonly slots: StoredSlot[] = [];
  readonly weeks = new Map<string, StoredWeek>();
  readonly results: StoredResult[] = [];
  readonly marks: { studentId: string; attendance: AttendanceMark }[] = [];

  addStudent(seed: StudentSeed = {}): { id: string; accountId: string } {
    const accountId = seed.accountId ?? randomUUID();
    const student: MeProfileRow = {
      id: randomUUID(),
      firstName: seed.firstName ?? 'Нигина',
      lastName: seed.lastName ?? 'Каримова',
      phone: '+99290123456' + String(this.studentsByAccount.size),
      birthDate: new Date('2004-05-17T00:00:00.000Z'),
      gender: Gender.FEMALE,
      address: 'Душанбе, ул. Рудаки, 12',
      email: 'nigina@mail.tj',
      extraPhones: ['+992921112233'],
      telegram: '@nigina',
      photoUrl: 'https://cdn.omuz.tj/students/nigina.jpg',
      status: seed.status ?? StudentStatus.ACTIVE,
      createdAt: new Date('2026-07-27T10:15:00.000Z'),
      branch: { id: randomUUID(), name: 'Sadbarg' },
      parents: [
        {
          relation: ParentRelation.MOTHER,
          parent: {
            id: randomUUID(),
            firstName: 'Гулнора',
            lastName: 'Каримова',
            phone: '+992907654321',
          },
        },
      ],
    };

    this.studentsByAccount.set(accountId, student);

    return { id: student.id, accountId };
  }

  addGroup(name = 'Frontend-1', courseTitle = 'Frontend Basic'): StoredGroup {
    return {
      id: randomUUID(),
      name,
      format: GroupFormat.OFFLINE,
      status: GroupStatus.ACTIVE,
      startDate: new Date('2026-09-01T00:00:00.000Z'),
      endDate: new Date('2026-11-30T00:00:00.000Z'),
      telegramUrl: 'https://t.me/omuz_frontend_1',
      course: { id: randomUUID(), title: courseTitle, subtitle: 'HTML, CSS, JavaScript' },
      branch: { id: randomUUID(), name: 'Sadbarg' },
      mentors: [
        {
          role: GroupMentorRole.TEACHING,
          employee: {
            id: randomUUID(),
            firstName: 'Фаррух',
            lastName: 'Раҳимов',
            middleName: 'Саидович',
          },
        },
      ],
    };
  }

  enroll(
    studentId: string,
    group: StoredGroup,
    overrides: Partial<Omit<MeMembershipRow, 'group'>> = {},
  ): StoredMembership {
    const row: StoredMembership = {
      studentId,
      group,
      status: GroupStudentStatus.ACTIVE,
      statusReason: null,
      statusChangedAt: null,
      // Время зачисления разводится по номеру записи: иначе порядок «свежие
      // сверху» зависел бы от того, уложились ли вставки в одну миллисекунду.
      enrolledAt: new Date(Date.now() + this.memberships.length),
      ...overrides,
    };
    this.memberships.push(row);

    return row;
  }

  addSlot(
    group: StoredGroup,
    dayOfWeek: WeekDay,
    startMinute: number,
    endMinute: number,
    room: MeSlotRow['room'] = { id: randomUUID(), name: '101' },
  ): StoredSlot {
    const row: StoredSlot = {
      id: randomUUID(),
      groupId: group.id,
      dayOfWeek,
      startMinute,
      endMinute,
      group: { id: group.id, name: group.name, course: group.course },
      room,
      mentor: {
        id: randomUUID(),
        firstName: 'Фаррух',
        lastName: 'Раҳимов',
        middleName: 'Саидович',
      },
    };
    this.slots.push(row);

    return row;
  }

  /** Неделя журнала группы; `submitted: false` — открытая, в общий балл не идёт. */
  addWeek(group: StoredGroup, weekNumber: number, submitted = true): StoredWeek {
    const week: StoredWeek = {
      id: randomUUID(),
      groupId: group.id,
      weekNumber,
      startDate: new Date(Date.UTC(2026, 8, weekNumber)),
      submittedAt: submitted ? new Date('2026-09-14T09:00:00.000Z') : null,
    };
    this.weeks.set(week.id, week);

    return week;
  }

  addResult(week: StoredWeek, studentId: string, sum: number, bonus = 0, exam = 0): void {
    this.results.push({ weekId: week.id, studentId, bonus, exam, sum });
  }

  addMarks(studentId: string, attendance: AttendanceMark, times: number): void {
    for (let index = 0; index < times; index += 1) {
      this.marks.push({ studentId, attendance });
    }
  }

  // ─── StudentCabinetRepository ───

  findByAccountId(accountId: string): Promise<MeProfileRow | null> {
    return Promise.resolve(this.studentsByAccount.get(accountId) ?? null);
  }

  findMemberships(
    params: MeMembershipListParams,
  ): Promise<{ rows: MeMembershipRow[]; total: number }> {
    const search = params.search?.toLowerCase();

    const matched = this.memberships
      .filter((row) => row.studentId === params.studentId)
      .filter((row) => params.status === undefined || row.status === params.status)
      .filter(
        (row) =>
          search === undefined ||
          row.group.name.toLowerCase().includes(search) ||
          row.group.course.title.toLowerCase().includes(search),
      )
      .sort((a, b) => {
        const asc =
          params.sort === MeGroupSortField.Name
            ? a.group.name.localeCompare(b.group.name)
            : a.enrolledAt.getTime() - b.enrolledAt.getTime();

        return params.order === SortOrder.Asc ? asc : -asc;
      });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findSchedule(params: MeScheduleListParams): Promise<{ rows: MeSlotRow[]; total: number }> {
    const search = params.search?.toLowerCase();
    const activeGroupIds = new Set(
      this.memberships
        .filter(
          (row) => row.studentId === params.studentId && row.status === GroupStudentStatus.ACTIVE,
        )
        .map((row) => row.group.id),
    );

    const matched = this.slots
      .filter((row) => activeGroupIds.has(row.groupId))
      .filter((row) => params.groupId === undefined || row.groupId === params.groupId)
      .filter((row) => params.dayOfWeek === undefined || row.dayOfWeek === params.dayOfWeek)
      .filter(
        (row) =>
          search === undefined ||
          row.group.name.toLowerCase().includes(search) ||
          (row.room?.name.toLowerCase().includes(search) ?? false) ||
          (row.mentor?.lastName.toLowerCase().includes(search) ?? false),
      )
      .sort((a, b) => {
        const byDay = WEEK_DAYS.indexOf(a.dayOfWeek) - WEEK_DAYS.indexOf(b.dayOfWeek);
        const byTime = a.startMinute - b.startMinute;
        const asc =
          params.sort === MeScheduleSortField.StartTime ? byTime || byDay : byDay || byTime;

        return params.order === SortOrder.Asc ? asc : -asc;
      });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findActiveMembership(studentId: string, groupId: string): Promise<{ groupId: string } | null> {
    const found = this.memberships.find(
      (row) =>
        row.studentId === studentId &&
        row.group.id === groupId &&
        row.status === GroupStudentStatus.ACTIVE,
    );

    return Promise.resolve(found ? { groupId } : null);
  }

  // ─── PerformanceRepository ───

  findStudent(id: string): Promise<{ id: string; firstName: string; lastName: string } | null> {
    const found = [...this.studentsByAccount.values()].find((row) => row.id === id);

    return Promise.resolve(
      found ? { id: found.id, firstName: found.firstName, lastName: found.lastName } : null,
    );
  }

  /** Только финализированные недели — то самое правило, ради которого балл вообще устойчив. */
  findFinalizedResults(studentId: string): Promise<StudentWeekResultRow[]> {
    return Promise.resolve(
      this.results.flatMap((result) => {
        const week = this.weeks.get(result.weekId);
        if (!week || week.submittedAt === null || result.studentId !== studentId) return [];

        return [
          {
            sum: result.sum,
            bonus: result.bonus,
            exam: result.exam,
            week: {
              id: week.id,
              weekNumber: week.weekNumber,
              startDate: week.startDate,
              submittedAt: week.submittedAt,
              groupId: week.groupId,
            },
          },
        ];
      }),
    );
  }

  findPerformanceMemberships(studentId: string): Promise<StudentMembershipRow[]> {
    return Promise.resolve(
      this.memberships
        .filter((row) => row.studentId === studentId)
        .map(({ status, group }) => ({
          status,
          group: {
            id: group.id,
            name: group.name,
            course: { id: group.course.id, title: group.course.title },
            branch: group.branch,
          },
        })),
    );
  }

  aggregateAttendance(studentId: string): Promise<AttendanceTally[]> {
    const counts = new Map<AttendanceMark, number>();
    for (const mark of this.marks.filter((row) => row.studentId === studentId)) {
      counts.set(mark.attendance, (counts.get(mark.attendance) ?? 0) + 1);
    }

    return Promise.resolve([...counts].map(([attendance, count]) => ({ attendance, count })));
  }

  /** В рейтинг идут только те, у кого есть действующее членство (решение сессии 0019). */
  findRankedAverages(): Promise<RankedAverage[]> {
    const ranked = new Set(
      this.memberships
        .filter((row) => row.status === GroupStudentStatus.ACTIVE)
        .map((row) => row.studentId),
    );

    const sums = new Map<string, number[]>();
    for (const result of this.results) {
      const week = this.weeks.get(result.weekId);
      if (!week || week.submittedAt === null || !ranked.has(result.studentId)) continue;

      sums.set(result.studentId, [...(sums.get(result.studentId) ?? []), result.sum]);
    }

    return Promise.resolve(
      [...sums].map(([studentId, values]) => ({
        studentId,
        average: values.reduce((total, value) => total + value, 0) / values.length,
      })),
    );
  }
}

/**
 * `findMemberships` у двух репозиториев называется одинаково, но отвечает разное:
 * кабинету нужны страница, фильтр и менторы, витрине успеваемости — все членства
 * целиком. Поэтому на `PerformanceRepository` хранилище подставляется отдельным
 * объектом, где имя переведено на `findPerformanceMemberships`.
 */
const asPerformanceRepository = (store: InMemoryCabinetStore): PerformanceRepository =>
  ({
    findStudent: (id: string) => store.findStudent(id),
    findFinalizedResults: (id: string) => store.findFinalizedResults(id),
    findMemberships: (id: string) => store.findPerformanceMemberships(id),
    aggregateAttendance: (id: string) => store.aggregateAttendance(id),
    findRankedAverages: () => store.findRankedAverages(),
  }) as unknown as PerformanceRepository;

interface ProfileBody {
  id: string;
  firstName: string;
  lastName: string;
  birthDate: string | null;
  parents: { phone: string; relation: ParentRelation | null }[];
  status: StudentStatus;
}

interface GroupBody {
  id: string;
  name: string;
  course: { id: string; title: string };
  status: GroupStudentStatus;
  statusReason: string | null;
  startDate: string | null;
  mentors: { lastName: string; role: GroupMentorRole }[];
}

interface SlotBody {
  id: string;
  group: { id: string; name: string; courseTitle: string };
  dayOfWeek: WeekDay;
  startTime: string;
  endTime: string;
  room: { name: string } | null;
}

interface PerformanceBody {
  student: { id: string; firstName: string; lastName: string };
  averageScore: number | null;
  category: ActivityCategory | null;
  categoryTitle: string | null;
  passing: boolean;
  weeksCount: number;
  rank: { position: number | null; totalRanked: number; isTopStudent: boolean; ranked: boolean };
  attendance: {
    present: number;
    late: number;
    absent: number;
    marked: number;
    attendanceRate: number | null;
  };
  groups: { groupName: string | null; averageScore: number | null; weeksCount: number }[];
}

describe('Кабинет студента (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryCabinetStore;
  let rbac: InMemoryRbacRepository;
  let tokens: TokenService;

  beforeEach(async () => {
    store = new InMemoryCabinetStore();
    rbac = new InMemoryRbacRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        PhoneModule,
        AuthModule,
        // `RbacModule` — из-за контроллера успеваемости, который приезжает вместе
        // с `PerformanceModule` внутри кабинета: он закрыт правом каталога.
        RbacModule,
        StudentCabinetModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
      ],
    })
      // AuthModule нужен целиком: он приносит глобальный `JwtAuthGuard`.
      .overrideProvider(AuthRepository)
      .useValue({})
      .overrideProvider(StudentCabinetRepository)
      .useValue(store)
      .overrideProvider(PerformanceRepository)
      .useValue(asPerformanceRepository(store))
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

  /** Токен студента с заведённым профилем. */
  const student = async (
    seed: StudentSeed = {},
  ): Promise<{ id: string; accountId: string; token: string }> => {
    const created = store.addStudent(seed);
    const { accessToken } = await tokens.issuePair({
      sub: created.accountId,
      sid: randomUUID(),
      type: AccountType.STUDENT,
    });

    return { ...created, token: accessToken };
  };

  /** Токен студента, у которого профиля нет: ТЗ 3.1 такого не допускает. */
  const orphanToken = async (): Promise<string> =>
    (await tokens.issuePair({ sub: randomUUID(), sid: randomUUID(), type: AccountType.STUDENT }))
      .accessToken;

  const employeeToken = async (): Promise<string> =>
    (await tokens.issuePair({ sub: randomUUID(), sid: randomUUID(), type: AccountType.EMPLOYEE }))
      .accessToken;

  /** Сотрудник с правом на карточки студентов — чтобы сверить кабинет с админ-стороной. */
  const staffToken = async (): Promise<string> => {
    const accountId = randomUUID();
    rbac.grant(accountId, ['Permission.Students.Views']);
    const { accessToken } = await tokens.issuePair({
      sub: accountId,
      sid: randomUUID(),
      type: AccountType.EMPLOYEE,
    });

    return accessToken;
  };

  const get = (url: string, token: string) =>
    request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);

  describe('Доступ (ТЗ 3.2)', () => {
    it('без токена — 401 на всех трёх маршрутах', async () => {
      const server = request(app.getHttpServer());

      await server.get('/api/v1/me').expect(401);
      await request(app.getHttpServer()).get('/api/v1/me/groups').expect(401);
      await request(app.getHttpServer()).get('/api/v1/me/schedule').expect(401);
    });

    it('сотруднику кабинет студента закрыт — 403', async () => {
      const token = await employeeToken();

      await get('/api/v1/me', token).expect(403);
      await get('/api/v1/me/groups', token).expect(403);
      await get('/api/v1/me/schedule', token).expect(403);
    });

    it('аккаунт студента без профиля — 404', async () => {
      await get('/api/v1/me', await orphanToken()).expect(404);
    });

    it('заблокированному кабинет закрыт целиком — 403 (ТЗ 5.3: Block = блок входа)', async () => {
      const blocked = await student({ status: StudentStatus.BLOCK });

      await get('/api/v1/me', blocked.token).expect(403);
      await get('/api/v1/me/groups', blocked.token).expect(403);
      await get('/api/v1/me/schedule', blocked.token).expect(403);
    });

    it('остальные статусы кабинет не закрывают', async () => {
      const left = await student({ status: StudentStatus.NO_ACTIVE });

      expect(dataOf<ProfileBody>(await get('/api/v1/me', left.token).expect(200)).status).toBe(
        StudentStatus.NO_ACTIVE,
      );
    });
  });

  describe('Свой профиль (ТЗ 5.3)', () => {
    it('отдаёт профиль вызывающего с родителями и датой YYYY-MM-DD', async () => {
      const me = await student({ firstName: 'Нигина', lastName: 'Каримова' });

      const body = dataOf<ProfileBody>(await get('/api/v1/me', me.token).expect(200));

      expect(body).toMatchObject({
        id: me.id,
        firstName: 'Нигина',
        lastName: 'Каримова',
        birthDate: '2004-05-17',
        status: StudentStatus.ACTIVE,
      });
      expect(body.parents).toEqual([
        expect.objectContaining({ phone: '+992907654321', relation: ParentRelation.MOTHER }),
      ]);
    });

    it('каждый студент получает свой профиль, а не чужой', async () => {
      const first = await student({ lastName: 'Каримова' });
      const second = await student({ lastName: 'Сафарова' });

      expect(dataOf<ProfileBody>(await get('/api/v1/me', first.token).expect(200)).id).toBe(
        first.id,
      );
      expect(dataOf<ProfileBody>(await get('/api/v1/me', second.token).expect(200)).lastName).toBe(
        'Сафарова',
      );
    });

    it('в теле нет заметок администратора, аккаунта и хеша пароля', async () => {
      const me = await student();

      const response = await get('/api/v1/me', me.token).expect(200);
      const raw = JSON.stringify(response.body);

      expect(raw).not.toContain('passwordHash');
      expect(raw).not.toContain('notes');
      expect(raw).not.toContain('account');
    });
  });

  describe('Свои группы (ТЗ 5.3)', () => {
    it('отдаёт членства с курсом и менторами в `{ data, meta }`', async () => {
      const me = await student();
      store.enroll(me.id, store.addGroup());

      const response = await get('/api/v1/me/groups', me.token).expect(200);
      const body = response.body as { data: GroupBody[]; meta: { total: number } };

      expect(body.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(body.data[0]).toMatchObject({
        name: 'Frontend-1',
        course: { title: 'Frontend Basic' },
        status: GroupStudentStatus.ACTIVE,
        startDate: '2026-09-01',
        mentors: [{ lastName: 'Раҳимов', role: GroupMentorRole.TEACHING }],
      });
    });

    it('закрытые членства остаются историей, `status=ACTIVE` оставляет текущие', async () => {
      const me = await student();
      store.enroll(me.id, store.addGroup('Python-1', 'Python Basic'), {
        status: GroupStudentStatus.LEFT,
        statusReason: 'Переехал в другой город',
        statusChangedAt: new Date('2026-10-15T08:30:00.000Z'),
      });
      store.enroll(me.id, store.addGroup());

      const all = await get('/api/v1/me/groups', me.token).expect(200);
      expect((all.body as { data: GroupBody[] }).data).toHaveLength(2);
      expect(
        (all.body as { data: GroupBody[] }).data.find(({ name }) => name === 'Python-1'),
      ).toMatchObject({
        status: GroupStudentStatus.LEFT,
        statusReason: 'Переехал в другой город',
      });

      const active = await get(
        `/api/v1/me/groups?status=${GroupStudentStatus.ACTIVE}`,
        me.token,
      ).expect(200);
      expect((active.body as { data: GroupBody[] }).data.map(({ name }) => name)).toEqual([
        'Frontend-1',
      ]);
    });

    it('свежие сверху по умолчанию', async () => {
      const me = await student();
      store.enroll(me.id, store.addGroup('Python-1', 'Python Basic'));
      store.enroll(me.id, store.addGroup('Frontend-1'));

      const response = await get('/api/v1/me/groups', me.token).expect(200);

      expect((response.body as { data: GroupBody[] }).data.map(({ name }) => name)).toEqual([
        'Frontend-1',
        'Python-1',
      ]);
    });

    it('группы соседнего студента в список не попадают', async () => {
      const me = await student();
      const neighbour = await student();
      store.enroll(me.id, store.addGroup('Frontend-1'));
      store.enroll(neighbour.id, store.addGroup('Python-1', 'Python Basic'));

      const response = await get('/api/v1/me/groups', me.token).expect(200);

      expect((response.body as { data: GroupBody[] }).data.map(({ name }) => name)).toEqual([
        'Frontend-1',
      ]);
    });

    it('поиск по названию курса и сортировка по названию группы', async () => {
      const me = await student();
      store.enroll(me.id, store.addGroup('Python-1', 'Python Basic'));
      store.enroll(me.id, store.addGroup('Frontend-1'));

      const searched = await get('/api/v1/me/groups?search=python', me.token).expect(200);
      expect((searched.body as { data: GroupBody[] }).data.map(({ name }) => name)).toEqual([
        'Python-1',
      ]);

      const sorted = await get('/api/v1/me/groups?sort=name&order=asc', me.token).expect(200);
      expect((sorted.body as { data: GroupBody[] }).data.map(({ name }) => name)).toEqual([
        'Frontend-1',
        'Python-1',
      ]);
    });

    it('400 на неизвестное поле сортировки и на неизвестный статус', async () => {
      const me = await student();

      await get('/api/v1/me/groups?sort=course', me.token).expect(400);
      await get('/api/v1/me/groups?status=UNKNOWN', me.token).expect(400);
    });
  });

  describe('Своё расписание (ТЗ 5.3, 5.5)', () => {
    it('отдаёт занятия своих групп с начала недели, время — HH:MM', async () => {
      const me = await student();
      const group = store.addGroup();
      store.enroll(me.id, group);
      store.addSlot(group, WeekDay.WEDNESDAY, 600, 720);
      store.addSlot(group, WeekDay.MONDAY, 840, 960);

      const response = await get('/api/v1/me/schedule', me.token).expect(200);
      const body = response.body as { data: SlotBody[]; meta: { total: number } };

      expect(body.meta).toMatchObject({ total: 2 });
      expect(body.data.map(({ dayOfWeek }) => dayOfWeek)).toEqual([
        WeekDay.MONDAY,
        WeekDay.WEDNESDAY,
      ]);
      expect(body.data[0]).toMatchObject({
        group: { name: 'Frontend-1', courseTitle: 'Frontend Basic' },
        startTime: '14:00',
        endTime: '16:00',
        room: { name: '101' },
      });
    });

    it('расписание покинутой группы в кабинет не попадает', async () => {
      const me = await student();
      const left = store.addGroup('Python-1', 'Python Basic');
      const current = store.addGroup('Frontend-1');
      store.enroll(me.id, left, { status: GroupStudentStatus.LEFT, statusReason: 'Ушёл' });
      store.enroll(me.id, current);
      store.addSlot(left, WeekDay.TUESDAY, 600, 720);
      store.addSlot(current, WeekDay.MONDAY, 600, 720);

      const response = await get('/api/v1/me/schedule', me.token).expect(200);

      expect((response.body as { data: SlotBody[] }).data.map(({ group }) => group.name)).toEqual([
        'Frontend-1',
      ]);
    });

    it('занятие онлайн отдаётся без аудитории', async () => {
      const me = await student();
      const group = store.addGroup();
      store.enroll(me.id, group);
      store.addSlot(group, WeekDay.MONDAY, 600, 720, null);

      const response = await get('/api/v1/me/schedule', me.token).expect(200);

      expect((response.body as { data: SlotBody[] }).data[0]?.room).toBeNull();
    });

    it('фильтры по дню недели и по своей группе', async () => {
      const me = await student();
      const group = store.addGroup();
      store.enroll(me.id, group);
      store.addSlot(group, WeekDay.MONDAY, 600, 720);
      store.addSlot(group, WeekDay.FRIDAY, 600, 720);

      const byDay = await get(`/api/v1/me/schedule?dayOfWeek=${WeekDay.FRIDAY}`, me.token).expect(
        200,
      );
      expect((byDay.body as { data: SlotBody[] }).data.map(({ dayOfWeek }) => dayOfWeek)).toEqual([
        WeekDay.FRIDAY,
      ]);

      const byGroup = await get(`/api/v1/me/schedule?groupId=${group.id}`, me.token).expect(200);
      expect((byGroup.body as { data: SlotBody[] }).data).toHaveLength(2);
    });

    it('422 на чужую группу и на несуществующую — ответ один и тот же', async () => {
      const me = await student();
      const neighbour = await student();
      const foreign = store.addGroup('Python-1', 'Python Basic');
      store.enroll(me.id, store.addGroup());
      store.enroll(neighbour.id, foreign);

      const alien = await get(`/api/v1/me/schedule?groupId=${foreign.id}`, me.token).expect(422);
      const missing = await get(`/api/v1/me/schedule?groupId=${randomUUID()}`, me.token).expect(
        422,
      );

      const messageOf = (response: { body: unknown }) =>
        (response.body as { error: { message: string } }).error.message;
      expect(messageOf(alien)).toBe(messageOf(missing));
    });

    it('покинутая группа в фильтре тоже 422: расписание — только действующих членств', async () => {
      const me = await student();
      const left = store.addGroup('Python-1', 'Python Basic');
      store.enroll(me.id, left, { status: GroupStudentStatus.LEFT, statusReason: 'Ушёл' });

      await get(`/api/v1/me/schedule?groupId=${left.id}`, me.token).expect(422);
    });

    it('занятия соседнего студента не попадают', async () => {
      const me = await student();
      const neighbour = await student();
      const mine = store.addGroup('Frontend-1');
      const theirs = store.addGroup('Python-1', 'Python Basic');
      store.enroll(me.id, mine);
      store.enroll(neighbour.id, theirs);
      store.addSlot(mine, WeekDay.MONDAY, 600, 720);
      store.addSlot(theirs, WeekDay.MONDAY, 600, 720);

      const response = await get('/api/v1/me/schedule', me.token).expect(200);

      expect((response.body as { data: SlotBody[] }).data.map(({ group }) => group.name)).toEqual([
        'Frontend-1',
      ]);
    });

    it('400 на не-UUID в фильтре группы и на неизвестный день недели', async () => {
      const me = await student();

      await get('/api/v1/me/schedule?groupId=не-uuid', me.token).expect(400);
      await get('/api/v1/me/schedule?dayOfWeek=ПОНЕДЕЛЬНИК', me.token).expect(400);
    });
  });

  describe('Свои баллы и рейтинг (ТЗ 5.3: «свои баллы», «рейтинг»)', () => {
    it('отдаёт общий балл, категорию, место и корону', async () => {
      const me = await student();
      const group = store.addGroup('Frontend-1');
      store.enroll(me.id, group);
      store.addResult(store.addWeek(group, 1), me.id, 100);
      store.addResult(store.addWeek(group, 2), me.id, 92);

      const body = dataOf<PerformanceBody>(
        await get('/api/v1/me/performance', me.token).expect(200),
      );

      expect(body).toMatchObject({
        student: { id: me.id },
        averageScore: 96,
        category: ActivityCategory.ChatGpt,
        categoryTitle: 'ChatGPT',
        passing: true,
        weeksCount: 2,
        rank: { position: 1, totalRanked: 1, isTopStudent: true, ranked: true },
      });
    });

    it('кабинет и карточка студента показывают один и тот же балл', async () => {
      const me = await student();
      const group = store.addGroup('Frontend-1');
      store.enroll(me.id, group);
      store.addResult(store.addWeek(group, 1), me.id, 87);
      store.addResult(store.addWeek(group, 2), me.id, 88);

      const mine = dataOf<PerformanceBody>(
        await get('/api/v1/me/performance', me.token).expect(200),
      );
      const card = dataOf<PerformanceBody>(
        await get(`/api/v1/students/${me.id}/performance`, await staffToken()).expect(200),
      );

      // Сравнение двух ответов между собой, а не с константой: расходиться им
      // нельзя по построению, и тест обязан ловить именно расхождение.
      expect(mine).toEqual(card);
      expect(mine.averageScore).toBe(87.5);
    });

    it('открытая неделя в свой балл не входит', async () => {
      const me = await student();
      const group = store.addGroup('Frontend-1');
      store.enroll(me.id, group);
      store.addResult(store.addWeek(group, 1), me.id, 100);
      store.addResult(store.addWeek(group, 2, false), me.id, 0);

      const body = dataOf<PerformanceBody>(
        await get('/api/v1/me/performance', me.token).expect(200),
      );

      expect(body).toMatchObject({ averageScore: 100, weeksCount: 1 });
    });

    it('до первой финализации балла нет — null, а не ноль (и не Black list)', async () => {
      const me = await student();
      const group = store.addGroup('Frontend-1');
      store.enroll(me.id, group);
      store.addResult(store.addWeek(group, 1, false), me.id, 0);

      const body = dataOf<PerformanceBody>(
        await get('/api/v1/me/performance', me.token).expect(200),
      );

      expect(body).toMatchObject({
        averageScore: null,
        category: null,
        categoryTitle: null,
        passing: false,
        weeksCount: 0,
        rank: { position: null, isTopStudent: false, ranked: false },
      });
    });

    it('своё место считается среди всех учащихся центра, а корона — у первого', async () => {
      const me = await student();
      const best = await student();
      const group = store.addGroup('Frontend-1');
      store.enroll(me.id, group);
      store.enroll(best.id, group);
      const week = store.addWeek(group, 1);
      store.addResult(week, me.id, 80);
      store.addResult(week, best.id, 100);

      const mine = dataOf<PerformanceBody>(
        await get('/api/v1/me/performance', me.token).expect(200),
      );
      const theirs = dataOf<PerformanceBody>(
        await get('/api/v1/me/performance', best.token).expect(200),
      );

      expect(mine.rank).toMatchObject({ position: 2, totalRanked: 2, isTopStudent: false });
      expect(theirs.rank).toMatchObject({ position: 1, totalRanked: 2, isTopStudent: true });
    });

    it('покинувший курс видит свой балл, но места в рейтинге у него нет', async () => {
      const me = await student({ status: StudentStatus.NO_ACTIVE });
      const group = store.addGroup('Frontend-1');
      store.enroll(me.id, group, {
        status: GroupStudentStatus.FINISHED,
        statusReason: 'Курс завершён',
        statusChangedAt: new Date('2026-11-30T12:00:00.000Z'),
      });
      store.addResult(store.addWeek(group, 1), me.id, 100);

      const body = dataOf<PerformanceBody>(
        await get('/api/v1/me/performance', me.token).expect(200),
      );

      expect(body).toMatchObject({
        averageScore: 100,
        rank: { position: null, totalRanked: 0, isTopStudent: false, ranked: false },
      });
    });

    it('разрез по группам держится за членства: группа без закрытых недель остаётся с null', async () => {
      const me = await student();
      const scored = store.addGroup('Frontend-1');
      const fresh = store.addGroup('Python-1', 'Python Basic');
      store.enroll(me.id, scored);
      store.enroll(me.id, fresh);
      store.addResult(store.addWeek(scored, 1), me.id, 90);

      const body = dataOf<PerformanceBody>(
        await get('/api/v1/me/performance', me.token).expect(200),
      );

      expect(
        body.groups.map(({ groupName, averageScore, weeksCount }) => ({
          groupName,
          averageScore,
          weeksCount,
        })),
      ).toEqual(
        expect.arrayContaining([
          { groupName: 'Frontend-1', averageScore: 90, weeksCount: 1 },
          { groupName: 'Python-1', averageScore: null, weeksCount: 0 },
        ]),
      );
    });

    it('посещаемость считает опоздание приходом (ТЗ 5.8)', async () => {
      const me = await student();
      store.addMarks(me.id, AttendanceMark.PRESENT, 4);
      store.addMarks(me.id, AttendanceMark.LATE, 1);
      store.addMarks(me.id, AttendanceMark.ABSENT, 1);

      const body = dataOf<PerformanceBody>(
        await get('/api/v1/me/performance', me.token).expect(200),
      );

      expect(body.attendance).toMatchObject({
        present: 4,
        late: 1,
        absent: 1,
        marked: 6,
        attendanceRate: 83.33,
      });
    });

    it('401 без токена, 403 сотруднику, 403 заблокированному', async () => {
      const blocked = await student({ status: StudentStatus.BLOCK });

      await request(app.getHttpServer()).get('/api/v1/me/performance').expect(401);
      await get('/api/v1/me/performance', await employeeToken()).expect(403);
      await get('/api/v1/me/performance', blocked.token).expect(403);
    });
  });

  describe('OpenAPI', () => {
    it('четыре пути кабинета описаны и доступны только на чтение', () => {
      const document = buildOpenApiDocument(app);

      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/me',
          '/api/v1/me/groups',
          '/api/v1/me/schedule',
          '/api/v1/me/performance',
        ]),
      );

      for (const path of ['/api/v1/me', '/api/v1/me/performance']) {
        const described = document.paths[path];
        expect(described?.get?.responses['200']).toBeDefined();
        expect(described?.post).toBeUndefined();
        expect(described?.put).toBeUndefined();
        expect(described?.delete).toBeUndefined();
      }
    });
  });
});
