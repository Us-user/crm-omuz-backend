import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  AccountType,
  AvansStatus,
  DirectoryStatus,
  DurationUnit,
  EmployeeStatus,
  Gender,
  GroupFormat,
  GroupMentorRole,
  GroupStatus,
  LessonType,
  Prisma,
  ResourceFileType,
  ResourceKind,
  WeekDay,
} from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import type {
  AvansCreateInput,
  AvansEmployee,
  AvansListParams,
  AvansRequestRow,
} from 'src/avans/avans.repository';
import { AvansRepository } from 'src/avans/avans.repository';
import { AvansSortField } from 'src/avans/dto';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, SortOrder, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import {
  MentorCourseSortField,
  MentorGroupSortField,
  MentorMaterialSortField,
  MentorTimetableSortField,
} from 'src/mentor-cabinet/dto';
import type {
  MentorCourseGroupRow,
  MentorCourseListParams,
  MentorCourseRow,
  MentorGroupListParams,
  MentorGroupRow,
  MentorLessonGroupRow,
  MentorLessonRow,
  MentorLevelOfMonthRow,
  MentorMaterialListParams,
  MentorProfileRow,
  MentorSlotRow,
  MentorTimetableListParams,
} from 'src/mentor-cabinet/mentor-cabinet.repository';
import { MentorCabinetRepository } from 'src/mentor-cabinet/mentor-cabinet.repository';
import { MentorCabinetModule } from 'src/mentor-cabinet/mentor-cabinet.module';
import { PhoneModule } from 'src/phone/phone.module';
// Лимиты частоты (Фаза 14) навешаны декоратором на эндпоинты auth,
// поэтому guard должен быть в графе. Redis набору не нужен: без клиента
// лимитер ничего не считает.
import { RateLimitModule } from 'src/rate-limit/rate-limit.module';
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

const WEEK_ORDER: WeekDay[] = [
  WeekDay.MONDAY,
  WeekDay.TUESDAY,
  WeekDay.WEDNESDAY,
  WeekDay.THURSDAY,
  WeekDay.FRIDAY,
  WeekDay.SATURDAY,
  WeekDay.SUNDAY,
];

type StoredGroup = MentorGroupRow['group'];
type StoredEmployee = MentorProfileRow & { accountId: string | null };
type StoredSlot = MentorSlotRow & { groupId: string };
interface StoredMentorship {
  groupId: string;
  employeeId: string;
  role: GroupMentorRole;
  assignedAt: Date;
}
type StoredLesson = MentorLessonRow & { visibleToGroupIds: string[] };

const has = (value: string | null, needle: string): boolean =>
  value !== null && value.toLowerCase().includes(needle.toLowerCase());

/**
 * Кабинет ментора в памяти: сотрудники, их аккаунты, менторство, группы, занятия,
 * курсы, уроки, уровни и заявки на аванс — **всё в одном хранилище**.
 *
 * Не ради удобства: правила модуля связывают эти сущности между собой. Каждая
 * выборка сужается менторством вызывающего, курсы выводятся из групп, материалы —
 * из «Show to group» тех же групп, а заявка о себе подписывается сотрудником,
 * найденным по аккаунту из токена. Разведённые заглушки проверяли бы не то
 * поведение, которое даёт БД.
 *
 * Тот же объект подставляется и на `MentorCabinetRepository`, и на
 * `AvansRepository` — иначе «подал о себе» и «эта заявка видна на админ-стороне»
 * держались бы на двух не связанных наборах данных.
 */
class InMemoryMentorStore {
  readonly employees = new Map<string, StoredEmployee>();
  readonly groups = new Map<string, StoredGroup>();
  readonly mentorships: StoredMentorship[] = [];
  readonly slots: StoredSlot[] = [];
  readonly courses = new Map<string, MentorCourseRow>();
  readonly lessons = new Map<string, StoredLesson>();
  readonly levelsByEmployee = new Map<string, MentorLevelOfMonthRow[]>();
  readonly requests = new Map<string, AvansRequestRow>();

  // ─────────────────────────── Наполнение ───────────────────────────

  addEmployee(overrides: Partial<StoredEmployee> = {}): StoredEmployee {
    const employee: StoredEmployee = {
      id: randomUUID(),
      firstName: 'Фаррух',
      lastName: 'Раҳимов',
      middleName: 'Азизович',
      phone: '+992901234567',
      birthDate: new Date('1992-03-14T00:00:00.000Z'),
      gender: Gender.MALE,
      address: 'Душанбе, ул. Рудаки, 15',
      email: 'farrukh@omuz.tj',
      telegram: '@farrukh',
      photoUrl: null,
      experience: '5 лет коммерческой разработки',
      description: null,
      status: EmployeeStatus.ACTIVE,
      hiredAt: new Date('2024-09-01T00:00:00.000Z'),
      createdAt: new Date('2024-08-20T10:00:00.000Z'),
      branch: { id: 'branch-1', name: 'Sadbarg' },
      positions: [{ position: { id: 'position-1', name: 'Mentor' } }],
      accountId: null,
      ...overrides,
    };
    this.employees.set(employee.id, employee);

    return employee;
  }

  addCourse(overrides: Partial<MentorCourseRow> = {}): MentorCourseRow {
    const course: MentorCourseRow = {
      id: randomUUID(),
      title: 'Frontend',
      subtitle: 'React и TypeScript',
      description: null,
      colorPrimary: '#1E88E5',
      colorSecondary: null,
      logoUrl: null,
      durationValue: 3,
      durationUnit: DurationUnit.MONTH,
      isLastCourse: false,
      status: DirectoryStatus.ACTIVE,
      createdAt: new Date(Date.now() + this.courses.size),
      ...overrides,
    };
    this.courses.set(course.id, course);

    return course;
  }

  addGroup(courseId: string, overrides: Partial<StoredGroup> = {}): StoredGroup {
    const course = this.courses.get(courseId);
    const group: StoredGroup = {
      id: randomUUID(),
      name: 'Frontend-1',
      description: null,
      format: GroupFormat.OFFLINE,
      status: GroupStatus.ACTIVE,
      startDate: new Date('2026-09-01T00:00:00.000Z'),
      endDate: null,
      capacity: 16,
      telegramUrl: null,
      course: {
        id: courseId,
        title: course?.title ?? 'Frontend',
        subtitle: course?.subtitle ?? null,
      },
      branch: { id: 'branch-1', name: 'Sadbarg' },
      _count: { students: 12 },
      ...overrides,
    };
    this.groups.set(group.id, group);

    return group;
  }

  assign(
    groupId: string,
    employeeId: string,
    role: GroupMentorRole = GroupMentorRole.TEACHING,
    assignedAt = new Date(Date.now() + this.mentorships.length),
  ): void {
    this.mentorships.push({ groupId, employeeId, role, assignedAt });
  }

  addSlot(groupId: string, overrides: Partial<StoredSlot> = {}): StoredSlot {
    const group = this.groups.get(groupId);
    const slot: StoredSlot = {
      id: randomUUID(),
      groupId,
      dayOfWeek: WeekDay.MONDAY,
      startMinute: 600,
      endMinute: 720,
      mentorId: null,
      group: {
        id: groupId,
        name: group?.name ?? 'Frontend-1',
        course: { id: group?.course.id ?? '', title: group?.course.title ?? 'Frontend' },
      },
      room: { id: 'room-1', name: '101' },
      mentor: null,
      ...overrides,
    };
    this.slots.push(slot);

    return slot;
  }

  addLesson(courseId: string, visibleToGroupIds: string[], overrides: Partial<StoredLesson> = {}) {
    const course = this.courses.get(courseId);
    const lesson: StoredLesson = {
      id: randomUUID(),
      courseId,
      dayNumber: 1,
      title: 'Введение в React',
      description: 'Компоненты и пропсы',
      type: LessonType.LECTURE,
      status: DirectoryStatus.ACTIVE,
      createdAt: new Date(Date.now() + this.lessons.size),
      course: { id: courseId, title: course?.title ?? 'Frontend' },
      files: [
        {
          id: randomUUID(),
          title: 'Слайды по хукам',
          kind: ResourceKind.LECTURE,
          fileType: ResourceFileType.SLIDES,
          url: 'https://drive.google.com/file/d/1abc/view',
          description: null,
        },
      ],
      visibleToGroupIds,
      ...overrides,
    };
    this.lessons.set(lesson.id, lesson);

    return lesson;
  }

  setLevel(employeeId: string, month: Date, hourlyRate: string, name = 'Senior mentor'): void {
    const rows = this.levelsByEmployee.get(employeeId) ?? [];
    rows.push({
      month,
      level: {
        id: `level-${name}`,
        name,
        hourlyRate: new Prisma.Decimal(hourlyRate),
        status: DirectoryStatus.ACTIVE,
      },
    });
    this.levelsByEmployee.set(employeeId, rows);
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

  private isMine(groupId: string, employeeId: string): boolean {
    return this.mentorships.some((row) => row.groupId === groupId && row.employeeId === employeeId);
  }

  // ─────────────────── MentorCabinetRepository ───────────────────

  findByAccountId(accountId: string): Promise<MentorProfileRow | null> {
    const found = [...this.employees.values()].find((row) => row.accountId === accountId);

    return Promise.resolve(found ?? null);
  }

  findLevelOfMonth(employeeId: string, month: Date): Promise<MentorLevelOfMonthRow | null> {
    const rows = this.levelsByEmployee.get(employeeId) ?? [];
    // Ровно один месяц: ближайший предыдущий не тянется (решение сессии 0021).
    const found = rows.find((row) => row.month.getTime() === month.getTime());

    return Promise.resolve(found ?? null);
  }

  findGroups(params: MentorGroupListParams): Promise<{ rows: MentorGroupRow[]; total: number }> {
    const matched = this.mentorships
      .filter((row) => row.employeeId === params.employeeId)
      .map((row) => ({ mentorship: row, group: this.groups.get(row.groupId) }))
      .filter(
        (row): row is { mentorship: StoredMentorship; group: StoredGroup } =>
          row.group !== undefined,
      )
      .filter((row) => params.role === undefined || row.mentorship.role === params.role)
      .filter((row) => params.status === undefined || row.group.status === params.status)
      .filter(
        (row) =>
          params.search === undefined ||
          has(row.group.name, params.search) ||
          has(row.group.course.title, params.search),
      )
      .sort((a, b) => {
        const asc =
          params.sort === MentorGroupSortField.Name
            ? a.group.name.localeCompare(b.group.name)
            : a.mentorship.assignedAt.getTime() - b.mentorship.assignedAt.getTime();

        return params.order === SortOrder.Asc ? asc : -asc;
      })
      .map(({ mentorship, group }) => ({
        role: mentorship.role,
        assignedAt: mentorship.assignedAt,
        group,
      }));

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findTimetable(
    params: MentorTimetableListParams,
  ): Promise<{ rows: MentorSlotRow[]; total: number }> {
    const matched = this.slots
      .filter((slot) => this.isMine(slot.groupId, params.employeeId))
      .filter((slot) => params.groupId === undefined || slot.groupId === params.groupId)
      .filter((slot) => params.dayOfWeek === undefined || slot.dayOfWeek === params.dayOfWeek)
      .filter((slot) =>
        params.onlyMine === undefined
          ? true
          : params.onlyMine
            ? slot.mentorId === params.employeeId
            : slot.mentorId === null || slot.mentorId !== params.employeeId,
      )
      .filter(
        (slot) =>
          params.search === undefined ||
          has(slot.group.name, params.search) ||
          has(slot.room?.name ?? null, params.search) ||
          has(slot.group.course.title, params.search),
      )
      .sort((a, b) => {
        const byDay = WEEK_ORDER.indexOf(a.dayOfWeek) - WEEK_ORDER.indexOf(b.dayOfWeek);
        const byTime = a.startMinute - b.startMinute;
        const asc =
          params.sort === MentorTimetableSortField.StartTime
            ? byTime === 0
              ? byDay
              : byTime
            : byDay === 0
              ? byTime
              : byDay;

        return params.order === SortOrder.Asc ? asc : -asc;
      });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findCourses(params: MentorCourseListParams): Promise<{ rows: MentorCourseRow[]; total: number }> {
    const myCourseIds = new Set(
      this.mentorships
        .filter((row) => row.employeeId === params.employeeId)
        .map((row) => this.groups.get(row.groupId)?.course.id)
        .filter((id): id is string => id !== undefined),
    );

    const matched = [...this.courses.values()]
      .filter((course) => myCourseIds.has(course.id))
      .filter(
        (course) =>
          params.search === undefined ||
          has(course.title, params.search) ||
          has(course.subtitle, params.search),
      )
      .sort((a, b) => {
        const asc =
          params.sort === MentorCourseSortField.CreatedAt
            ? a.createdAt.getTime() - b.createdAt.getTime()
            : a.title.localeCompare(b.title);

        return params.order === SortOrder.Asc ? asc : -asc;
      });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findGroupsOfCourses(
    employeeId: string,
    courseIds: readonly string[],
  ): Promise<MentorCourseGroupRow[]> {
    const rows = [...this.groups.values()]
      .filter((group) => courseIds.includes(group.course.id) && this.isMine(group.id, employeeId))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((group) => ({ id: group.id, name: group.name, courseId: group.course.id }));

    return Promise.resolve(rows);
  }

  findMaterials(
    params: MentorMaterialListParams,
  ): Promise<{ rows: MentorLessonRow[]; total: number }> {
    const matched = [...this.lessons.values()]
      .filter((lesson) =>
        lesson.visibleToGroupIds.some(
          (groupId) =>
            this.isMine(groupId, params.employeeId) &&
            (params.groupId === undefined || groupId === params.groupId),
        ),
      )
      .filter((lesson) => params.courseId === undefined || lesson.courseId === params.courseId)
      .filter((lesson) => params.type === undefined || lesson.type === params.type)
      .filter(
        (lesson) =>
          params.search === undefined ||
          has(lesson.title, params.search) ||
          has(lesson.description, params.search),
      )
      .sort((a, b) => {
        const asc =
          params.sort === MentorMaterialSortField.Title
            ? a.title.localeCompare(b.title)
            : params.sort === MentorMaterialSortField.CreatedAt
              ? a.createdAt.getTime() - b.createdAt.getTime()
              : a.dayNumber - b.dayNumber;

        return params.order === SortOrder.Asc ? asc : -asc;
      });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findGroupsOfLessons(
    employeeId: string,
    lessonIds: readonly string[],
  ): Promise<MentorLessonGroupRow[]> {
    const rows = lessonIds.flatMap((lessonId) => {
      const lesson = this.lessons.get(lessonId);
      if (!lesson) return [];

      return lesson.visibleToGroupIds
        .filter((groupId) => this.isMine(groupId, employeeId))
        .map((groupId) => this.groups.get(groupId))
        .filter((group): group is StoredGroup => group !== undefined)
        .map((group) => ({ lessonId, id: group.id, name: group.name }));
    });

    return Promise.resolve(rows.sort((a, b) => a.name.localeCompare(b.name)));
  }

  findAssignment(employeeId: string, groupId: string): Promise<{ groupId: string } | null> {
    return Promise.resolve(this.isMine(groupId, employeeId) ? { groupId } : null);
  }

  // ────────────────────────── AvansRepository ──────────────────────────

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
}

interface ProfileBody {
  id: string;
  firstName: string;
  lastName: string;
  birthDate: string | null;
  hiredAt: string | null;
  status: EmployeeStatus;
  positions: { id: string; name: string }[];
  level: { month: string; id: string; name: string; hourlyRate: number } | null;
}

interface GroupBody {
  id: string;
  name: string;
  role: GroupMentorRole;
  capacity: number | null;
  enrolledCount: number;
  course: { id: string; title: string };
  startDate: string | null;
}

interface SlotBody {
  id: string;
  dayOfWeek: WeekDay;
  startTime: string;
  endTime: string;
  mine: boolean;
  room: { id: string; name: string } | null;
  mentor: { id: string } | null;
  group: { id: string; name: string; courseTitle: string };
}

interface CourseBody {
  id: string;
  title: string;
  groups: { id: string; name: string }[];
}

interface MaterialBody {
  id: string;
  title: string;
  dayNumber: number;
  type: LessonType;
  course: { id: string; title: string };
  groups: { id: string; name: string }[];
  files: { id: string; title: string; url: string }[];
}

interface AvansBody {
  id: string;
  employeeId: string;
  amount: number;
  month: string;
  status: AvansStatus;
  createdBy: { id: string } | null;
}

/** Первое число текущего месяца — тот же вид, в каком месяц лежит в БД. */
const currentMonth = (): Date => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
};

const currentMonthLabel = (): string => currentMonth().toISOString().slice(0, 7);

const AVANS = { amount: 500, reason: 'Оплата аренды жилья', month: '2026-09' };

describe('Кабинет ментора (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryMentorStore;
  let rbac: InMemoryRbacRepository;
  let tokens: TokenService;

  beforeEach(async () => {
    store = new InMemoryMentorStore();
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
        MentorCabinetModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
      ],
    })
      // AuthModule нужен целиком: он приносит глобальный `JwtAuthGuard`.
      .overrideProvider(AuthRepository)
      .useValue({})
      .overrideProvider(MentorCabinetRepository)
      .useValue(store)
      // Тот же объект: заявка о себе подписывается сотрудником из того же хранилища.
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

  /** Сотрудник с аккаунтом и токеном — кабинет всё выводит из этого аккаунта. */
  const mentorWith = async (
    overrides: Partial<StoredEmployee> = {},
    codes: string[] = [],
  ): Promise<{ employee: StoredEmployee; token: string; accountId: string }> => {
    const accountId = randomUUID();
    const employee = store.addEmployee({ ...overrides, accountId });
    rbac.grant(accountId, codes);
    const { accessToken } = await tokens.issuePair({
      sub: accountId,
      sid: randomUUID(),
      type: AccountType.EMPLOYEE,
    });

    return { employee, token: accessToken, accountId };
  };

  const orphanToken = async (): Promise<string> => {
    const accountId = randomUUID();
    rbac.grant(accountId, []);
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
  const del = (url: string, token: string) =>
    server().delete(url).set('Authorization', `Bearer ${token}`);

  // ───────────────────────────── Доступ ─────────────────────────────

  describe('Доступ', () => {
    it('401 без токена на всех разделах', async () => {
      await server().get('/api/v1/mentor/profile').expect(401);
      await server().get('/api/v1/mentor/groups').expect(401);
      await server().get('/api/v1/mentor/timetable').expect(401);
      await server().get('/api/v1/mentor/courses').expect(401);
      await server().get('/api/v1/mentor/materials').expect(401);
      await server().get('/api/v1/mentor/avans').expect(401);
    });

    it('403 студенту: кабинет ментора — не его контур', async () => {
      const token = await studentToken();

      await get('/api/v1/mentor/profile', token).expect(403);
      await get('/api/v1/mentor/groups', token).expect(403);
      await get('/api/v1/mentor/avans', token).expect(403);
    });

    it('сотруднику без единого права кабинет открыт: он показывает только своё', async () => {
      const { token } = await mentorWith({}, []);

      await get('/api/v1/mentor/profile', token).expect(200);
      await get('/api/v1/mentor/groups', token).expect(200);
      await get('/api/v1/mentor/timetable', token).expect(200);
      await get('/api/v1/mentor/courses', token).expect(200);
      await get('/api/v1/mentor/materials', token).expect(200);
      await get('/api/v1/mentor/avans', token).expect(200);
    });

    it('403 выведенному из штата — на всех разделах сразу', async () => {
      const { token } = await mentorWith({ status: EmployeeStatus.INACTIVE });

      await get('/api/v1/mentor/profile', token).expect(403);
      await get('/api/v1/mentor/groups', token).expect(403);
      await get('/api/v1/mentor/timetable', token).expect(403);
      await get('/api/v1/mentor/courses', token).expect(403);
      await get('/api/v1/mentor/materials', token).expect(403);
      await get('/api/v1/mentor/avans', token).expect(403);
      await post('/api/v1/mentor/avans', token, AVANS).expect(403);
      expect(store.requests.size).toBe(0);
    });

    it('404 аккаунту сотрудника без профиля', async () => {
      await get('/api/v1/mentor/profile', await orphanToken()).expect(404);
    });

    it('каждый получает свой профиль, а не чужой', async () => {
      const first = await mentorWith({ firstName: 'Фаррух', phone: '+992901111111' });
      const second = await mentorWith({ firstName: 'Нигина', phone: '+992902222222' });

      const one = await get('/api/v1/mentor/profile', first.token).expect(200);
      const two = await get('/api/v1/mentor/profile', second.token).expect(200);

      expect(dataOf<ProfileBody>(one).id).toBe(first.employee.id);
      expect(dataOf<ProfileBody>(two).id).toBe(second.employee.id);
      expect(dataOf<ProfileBody>(two).firstName).toBe('Нигина');
    });
  });

  // ───────────────────────────── Профиль ─────────────────────────────

  describe('Профиль, уровень и ставка (ТЗ 5.4)', () => {
    it('отдаёт профиль с позициями и датами в формате YYYY-MM-DD', async () => {
      const { token, employee } = await mentorWith();

      const response = await get('/api/v1/mentor/profile', token).expect(200);
      const body = dataOf<ProfileBody>(response);

      expect(body).toMatchObject({
        id: employee.id,
        firstName: 'Фаррух',
        lastName: 'Раҳимов',
        birthDate: '1992-03-14',
        hiredAt: '2024-09-01',
        status: EmployeeStatus.ACTIVE,
      });
      expect(body.positions).toEqual([{ id: 'position-1', name: 'Mentor' }]);
    });

    it('отдаёт уровень и часовую ставку текущего месяца с явно названным месяцем', async () => {
      const { token, employee } = await mentorWith();
      store.setLevel(employee.id, currentMonth(), '45.50');

      const response = await get('/api/v1/mentor/profile', token).expect(200);

      expect(dataOf<ProfileBody>(response).level).toEqual({
        month: currentMonthLabel(),
        id: 'level-Senior mentor',
        name: 'Senior mentor',
        hourlyRate: 45.5,
        status: DirectoryStatus.ACTIVE,
      });
    });

    it('месяц без записи означает отсутствие уровня: прошлый сюда не тянется', async () => {
      const { token, employee } = await mentorWith();
      // Уровень проставлен только прошлому месяцу.
      const previous = currentMonth();
      previous.setUTCMonth(previous.getUTCMonth() - 1);
      store.setLevel(employee.id, previous, '20.00', 'Junior mentor');

      const response = await get('/api/v1/mentor/profile', token).expect(200);

      expect(dataOf<ProfileBody>(response).level).toBeNull();
    });

    it('в теле профиля нет данных аккаунта и хеша пароля', async () => {
      const { token } = await mentorWith();

      const response = await get('/api/v1/mentor/profile', token).expect(200);
      const raw = JSON.stringify(response.body);

      expect(raw).not.toContain('passwordHash');
      expect(raw).not.toContain('accountId');
      expect(Object.keys(dataOf<ProfileBody>(response))).not.toContain('account');
    });
  });

  // ────────────────────────────── Группы ──────────────────────────────

  describe('Свои группы (ТЗ 5.4, раздел «Groups»)', () => {
    it('отдаёт группы под менторством с ролью, курсом и «набрано/вместимость»', async () => {
      const { token, employee } = await mentorWith();
      const course = store.addCourse();
      const group = store.addGroup(course.id, { name: 'Frontend-1' });
      store.assign(group.id, employee.id, GroupMentorRole.SUPPORT);

      const response = await get('/api/v1/mentor/groups', token).expect(200);
      const items = dataOf<GroupBody[]>(response);

      expect(metaOf(response)).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(items[0]).toMatchObject({
        id: group.id,
        name: 'Frontend-1',
        role: GroupMentorRole.SUPPORT,
        capacity: 16,
        enrolledCount: 12,
        startDate: '2026-09-01',
      });
      expect(items[0]?.course).toMatchObject({ id: course.id, title: 'Frontend' });
    });

    it('группы соседнего ментора в список не попадают', async () => {
      const mine = await mentorWith({ phone: '+992901111111' });
      const other = await mentorWith({ phone: '+992902222222' });
      const course = store.addCourse();
      const myGroup = store.addGroup(course.id, { name: 'Frontend-1' });
      const otherGroup = store.addGroup(course.id, { name: 'Frontend-2' });
      store.assign(myGroup.id, mine.employee.id);
      store.assign(otherGroup.id, other.employee.id);

      const response = await get('/api/v1/mentor/groups', mine.token).expect(200);

      expect(dataOf<GroupBody[]>(response)).toHaveLength(1);
      expect(dataOf<GroupBody[]>(response)[0]?.name).toBe('Frontend-1');
    });

    it('фильтры по роли и статусу группы', async () => {
      const { token, employee } = await mentorWith();
      const course = store.addCourse();
      const teaching = store.addGroup(course.id, { name: 'Frontend-1' });
      const support = store.addGroup(course.id, {
        name: 'Frontend-2',
        status: GroupStatus.FINISHED,
      });
      store.assign(teaching.id, employee.id, GroupMentorRole.TEACHING);
      store.assign(support.id, employee.id, GroupMentorRole.SUPPORT);

      const byRole = await get('/api/v1/mentor/groups?role=SUPPORT', token).expect(200);
      expect(dataOf<GroupBody[]>(byRole).map((row) => row.name)).toEqual(['Frontend-2']);

      const byStatus = await get('/api/v1/mentor/groups?status=ACTIVE', token).expect(200);
      expect(dataOf<GroupBody[]>(byStatus).map((row) => row.name)).toEqual(['Frontend-1']);
    });

    it('поиск идёт по названию группы и названию курса', async () => {
      const { token, employee } = await mentorWith();
      const front = store.addCourse({ title: 'Frontend' });
      const python = store.addCourse({ title: 'Python' });
      const first = store.addGroup(front.id, { name: 'Утренняя' });
      const second = store.addGroup(python.id, { name: 'Вечерняя' });
      store.assign(first.id, employee.id);
      store.assign(second.id, employee.id);

      const byCourse = await get('/api/v1/mentor/groups?search=python', token).expect(200);
      expect(dataOf<GroupBody[]>(byCourse).map((row) => row.name)).toEqual(['Вечерняя']);

      const byName = await get('/api/v1/mentor/groups?search=Утр', token).expect(200);
      expect(dataOf<GroupBody[]>(byName).map((row) => row.name)).toEqual(['Утренняя']);
    });

    it('400 на неизвестное поле сортировки', async () => {
      const { token } = await mentorWith();

      await get('/api/v1/mentor/groups?sort=capacity', token).expect(400);
    });

    it('сотрудник без единой группы получает пустой список, а не отказ', async () => {
      const { token } = await mentorWith();

      const response = await get('/api/v1/mentor/groups', token).expect(200);

      expect(dataOf<GroupBody[]>(response)).toEqual([]);
      expect(metaOf(response).total).toBe(0);
    });
  });

  // ──────────────────────────── Расписание ────────────────────────────

  describe('Своё расписание (ТЗ 5.4, раздел «Timetable»)', () => {
    it('занятие без назначенного ведущего остаётся в расписании — mine = false', async () => {
      const { token, employee } = await mentorWith();
      const course = store.addCourse();
      const group = store.addGroup(course.id);
      store.assign(group.id, employee.id);
      store.addSlot(group.id);

      const response = await get('/api/v1/mentor/timetable', token).expect(200);
      const items = dataOf<SlotBody[]>(response);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
        mine: false,
      });
      expect(items[0]?.group).toMatchObject({ name: 'Frontend-1', courseTitle: 'Frontend' });
    });

    it('своё занятие помечается mine = true', async () => {
      const { token, employee } = await mentorWith();
      const course = store.addCourse();
      const group = store.addGroup(course.id);
      store.assign(group.id, employee.id);
      store.addSlot(group.id, {
        mentorId: employee.id,
        mentor: {
          id: employee.id,
          firstName: employee.firstName,
          lastName: employee.lastName,
          middleName: employee.middleName,
        },
      });

      const response = await get('/api/v1/mentor/timetable', token).expect(200);

      expect(dataOf<SlotBody[]>(response)[0]?.mine).toBe(true);
    });

    it('onlyMine=true оставляет свои занятия, onlyMine=false — занятия коллег и без ведущего', async () => {
      const { token, employee } = await mentorWith({ phone: '+992901111111' });
      const colleague = await mentorWith({ phone: '+992902222222' });
      const course = store.addCourse();
      const group = store.addGroup(course.id);
      store.assign(group.id, employee.id);
      store.assign(group.id, colleague.employee.id);
      store.addSlot(group.id, { dayOfWeek: WeekDay.MONDAY, mentorId: employee.id });
      store.addSlot(group.id, {
        dayOfWeek: WeekDay.TUESDAY,
        mentorId: colleague.employee.id,
      });
      store.addSlot(group.id, { dayOfWeek: WeekDay.WEDNESDAY });

      const all = await get('/api/v1/mentor/timetable', token).expect(200);
      expect(dataOf<SlotBody[]>(all)).toHaveLength(3);

      const mine = await get('/api/v1/mentor/timetable?onlyMine=true', token).expect(200);
      expect(dataOf<SlotBody[]>(mine).map((row) => row.dayOfWeek)).toEqual([WeekDay.MONDAY]);

      const others = await get('/api/v1/mentor/timetable?onlyMine=false', token).expect(200);
      expect(dataOf<SlotBody[]>(others).map((row) => row.dayOfWeek)).toEqual([
        WeekDay.TUESDAY,
        WeekDay.WEDNESDAY,
      ]);
    });

    it('читается с начала недели, занятия соседней группы не попадают', async () => {
      const mine = await mentorWith({ phone: '+992901111111' });
      const other = await mentorWith({ phone: '+992902222222' });
      const course = store.addCourse();
      const myGroup = store.addGroup(course.id, { name: 'Frontend-1' });
      const otherGroup = store.addGroup(course.id, { name: 'Frontend-2' });
      store.assign(myGroup.id, mine.employee.id);
      store.assign(otherGroup.id, other.employee.id);
      store.addSlot(myGroup.id, { dayOfWeek: WeekDay.FRIDAY });
      store.addSlot(myGroup.id, { dayOfWeek: WeekDay.TUESDAY });
      store.addSlot(otherGroup.id, { dayOfWeek: WeekDay.MONDAY });

      const response = await get('/api/v1/mentor/timetable', mine.token).expect(200);

      expect(dataOf<SlotBody[]>(response).map((row) => row.dayOfWeek)).toEqual([
        WeekDay.TUESDAY,
        WeekDay.FRIDAY,
      ]);
    });

    it('фильтр по дню недели', async () => {
      const { token, employee } = await mentorWith();
      const course = store.addCourse();
      const group = store.addGroup(course.id);
      store.assign(group.id, employee.id);
      store.addSlot(group.id, { dayOfWeek: WeekDay.MONDAY });
      store.addSlot(group.id, { dayOfWeek: WeekDay.FRIDAY });

      const response = await get('/api/v1/mentor/timetable?dayOfWeek=FRIDAY', token).expect(200);

      expect(dataOf<SlotBody[]>(response)).toHaveLength(1);
    });

    it('422 на чужую группу в фильтре — тем же текстом, что и на несуществующую', async () => {
      const mine = await mentorWith({ phone: '+992901111111' });
      const other = await mentorWith({ phone: '+992902222222' });
      const course = store.addCourse();
      const otherGroup = store.addGroup(course.id);
      store.assign(otherGroup.id, other.employee.id);

      const foreign = await get(
        `/api/v1/mentor/timetable?groupId=${otherGroup.id}`,
        mine.token,
      ).expect(422);
      const missing = await get(
        `/api/v1/mentor/timetable?groupId=${randomUUID()}`,
        mine.token,
      ).expect(422);

      expect(messageOf(foreign)).toBe(messageOf(missing));
    });

    it('400 на не-UUID в фильтре и на неизвестный день недели', async () => {
      const { token } = await mentorWith();

      await get('/api/v1/mentor/timetable?groupId=не-uuid', token).expect(400);
      await get('/api/v1/mentor/timetable?dayOfWeek=FUNDAY', token).expect(400);
    });
  });

  // ────────────────────────────── Курсы ──────────────────────────────

  describe('Свои курсы (ТЗ 5.4, раздел «Courses»)', () => {
    it('отдаёт курсы своих групп вместе с этими группами', async () => {
      const { token, employee } = await mentorWith();
      const course = store.addCourse({ title: 'Frontend' });
      const first = store.addGroup(course.id, { name: 'Frontend-1' });
      const second = store.addGroup(course.id, { name: 'Frontend-2' });
      store.assign(first.id, employee.id);
      store.assign(second.id, employee.id);

      const response = await get('/api/v1/mentor/courses', token).expect(200);
      const items = dataOf<CourseBody[]>(response);

      expect(items).toHaveLength(1);
      expect(items[0]?.title).toBe('Frontend');
      expect(items[0]?.groups.map((row) => row.name)).toEqual(['Frontend-1', 'Frontend-2']);
    });

    it('группа коллеги того же курса в мои группы не попадает', async () => {
      const mine = await mentorWith({ phone: '+992901111111' });
      const other = await mentorWith({ phone: '+992902222222' });
      const course = store.addCourse();
      const myGroup = store.addGroup(course.id, { name: 'Frontend-1' });
      const otherGroup = store.addGroup(course.id, { name: 'Frontend-2' });
      store.assign(myGroup.id, mine.employee.id);
      store.assign(otherGroup.id, other.employee.id);

      const response = await get('/api/v1/mentor/courses', mine.token).expect(200);

      expect(dataOf<CourseBody[]>(response)[0]?.groups.map((row) => row.name)).toEqual([
        'Frontend-1',
      ]);
    });

    it('курс, который ведёт кто-то другой, в список не попадает', async () => {
      const mine = await mentorWith({ phone: '+992901111111' });
      const other = await mentorWith({ phone: '+992902222222' });
      const front = store.addCourse({ title: 'Frontend' });
      const python = store.addCourse({ title: 'Python' });
      const myGroup = store.addGroup(front.id);
      const otherGroup = store.addGroup(python.id);
      store.assign(myGroup.id, mine.employee.id);
      store.assign(otherGroup.id, other.employee.id);

      const response = await get('/api/v1/mentor/courses', mine.token).expect(200);

      expect(dataOf<CourseBody[]>(response).map((row) => row.title)).toEqual(['Frontend']);
    });

    it('стоимости курса в ответе нет: цена — данные бухгалтерии', async () => {
      const { token, employee } = await mentorWith();
      const course = store.addCourse();
      const group = store.addGroup(course.id);
      store.assign(group.id, employee.id);

      const response = await get('/api/v1/mentor/courses', token).expect(200);

      expect(Object.keys(dataOf<CourseBody[]>(response)[0] ?? {})).not.toContain('fee');
    });

    it('поиск по названию курса', async () => {
      const { token, employee } = await mentorWith();
      const front = store.addCourse({ title: 'Frontend' });
      const python = store.addCourse({ title: 'Python' });
      const first = store.addGroup(front.id, { name: 'F-1' });
      const second = store.addGroup(python.id, { name: 'P-1' });
      store.assign(first.id, employee.id);
      store.assign(second.id, employee.id);

      const response = await get('/api/v1/mentor/courses?search=pyth', token).expect(200);

      expect(dataOf<CourseBody[]>(response).map((row) => row.title)).toEqual(['Python']);
    });
  });

  // ───────────────────────────── Материалы ─────────────────────────────

  describe('Материалы своих групп (ТЗ 5.4, раздел «Material»)', () => {
    it('отдаёт уроки, открытые моей группе, вместе с файлами', async () => {
      const { token, employee } = await mentorWith();
      const course = store.addCourse();
      const group = store.addGroup(course.id, { name: 'Frontend-1' });
      store.assign(group.id, employee.id);
      const lesson = store.addLesson(course.id, [group.id]);

      const response = await get('/api/v1/mentor/materials', token).expect(200);
      const items = dataOf<MaterialBody[]>(response);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: lesson.id,
        title: 'Введение в React',
        dayNumber: 1,
        type: LessonType.LECTURE,
      });
      expect(items[0]?.course).toMatchObject({ id: course.id, title: 'Frontend' });
      expect(items[0]?.groups).toEqual([{ id: group.id, name: 'Frontend-1' }]);
      expect(items[0]?.files[0]).toMatchObject({
        title: 'Слайды по хукам',
        url: 'https://drive.google.com/file/d/1abc/view',
      });
    });

    it('урок курса, который группе не открыт, в материалы не попадает', async () => {
      const { token, employee } = await mentorWith();
      const course = store.addCourse();
      const group = store.addGroup(course.id);
      store.assign(group.id, employee.id);
      store.addLesson(course.id, [], { title: 'Скрытый урок' });
      store.addLesson(course.id, [group.id], { title: 'Открытый урок' });

      const response = await get('/api/v1/mentor/materials', token).expect(200);

      expect(dataOf<MaterialBody[]>(response).map((row) => row.title)).toEqual(['Открытый урок']);
    });

    it('материалы группы коллеги не попадают, а чужая группа не видна в списке своих', async () => {
      const mine = await mentorWith({ phone: '+992901111111' });
      const other = await mentorWith({ phone: '+992902222222' });
      const course = store.addCourse();
      const myGroup = store.addGroup(course.id, { name: 'Frontend-1' });
      const otherGroup = store.addGroup(course.id, { name: 'Frontend-2' });
      store.assign(myGroup.id, mine.employee.id);
      store.assign(otherGroup.id, other.employee.id);
      store.addLesson(course.id, [otherGroup.id], { title: 'Только соседям' });
      store.addLesson(course.id, [myGroup.id, otherGroup.id], { title: 'Обеим группам' });

      const response = await get('/api/v1/mentor/materials', mine.token).expect(200);
      const items = dataOf<MaterialBody[]>(response);

      expect(items.map((row) => row.title)).toEqual(['Обеим группам']);
      // Урок открыт двум группам, но в ответе — только своя.
      expect(items[0]?.groups.map((row) => row.name)).toEqual(['Frontend-1']);
    });

    it('порядок по учебным дням, фильтр по типу занятия', async () => {
      const { token, employee } = await mentorWith();
      const course = store.addCourse();
      const group = store.addGroup(course.id);
      store.assign(group.id, employee.id);
      store.addLesson(course.id, [group.id], {
        dayNumber: 3,
        title: 'Практика',
        type: LessonType.PRACTICE,
      });
      store.addLesson(course.id, [group.id], { dayNumber: 1, title: 'Лекция' });

      const all = await get('/api/v1/mentor/materials', token).expect(200);
      expect(dataOf<MaterialBody[]>(all).map((row) => row.title)).toEqual(['Лекция', 'Практика']);

      const practice = await get('/api/v1/mentor/materials?type=PRACTICE', token).expect(200);
      expect(dataOf<MaterialBody[]>(practice).map((row) => row.title)).toEqual(['Практика']);
    });

    it('фильтр по своей группе оставляет только её материалы', async () => {
      const { token, employee } = await mentorWith();
      const course = store.addCourse();
      const first = store.addGroup(course.id, { name: 'Frontend-1' });
      const second = store.addGroup(course.id, { name: 'Frontend-2' });
      store.assign(first.id, employee.id);
      store.assign(second.id, employee.id);
      store.addLesson(course.id, [first.id], { title: 'Первой группе' });
      store.addLesson(course.id, [second.id], { title: 'Второй группе' });

      const response = await get(`/api/v1/mentor/materials?groupId=${first.id}`, token).expect(200);

      expect(dataOf<MaterialBody[]>(response).map((row) => row.title)).toEqual(['Первой группе']);
    });

    it('422 на чужую группу в фильтре материалов', async () => {
      const mine = await mentorWith({ phone: '+992901111111' });
      const other = await mentorWith({ phone: '+992902222222' });
      const course = store.addCourse();
      const otherGroup = store.addGroup(course.id);
      store.assign(otherGroup.id, other.employee.id);

      await get(`/api/v1/mentor/materials?groupId=${otherGroup.id}`, mine.token).expect(422);
    });
  });

  // ──────────────────────── Аванс о себе (ТЗ 5.4) ────────────────────────

  describe('Свои заявки на аванс', () => {
    it('ментор подаёт заявку сам, без права Avans.Create, и она подписана им же', async () => {
      const { token, employee } = await mentorWith({}, []);

      const response = await post('/api/v1/mentor/avans', token, AVANS).expect(201);
      const body = dataOf<AvansBody>(response);

      expect(body).toMatchObject({
        employeeId: employee.id,
        amount: 500,
        month: '2026-09',
        status: AvansStatus.PENDING,
      });
      expect(body.createdBy).toMatchObject({ id: employee.id });
      expect(store.requestsOf(employee.id)).toHaveLength(1);
    });

    it('вторая нерассмотренная заявка — 409, и она не заведена', async () => {
      const { token, employee } = await mentorWith();

      await post('/api/v1/mentor/avans', token, AVANS).expect(201);
      const conflict = await post('/api/v1/mentor/avans', token, {
        ...AVANS,
        amount: 700,
      }).expect(409);

      expect(messageOf(conflict)).toContain('500');
      expect(messageOf(conflict)).toContain('2026-09');
      expect(store.requestsOf(employee.id)).toHaveLength(1);
    });

    it('отозвал свою заявку — можно подать следующую', async () => {
      const { token, employee } = await mentorWith();

      const created = await post('/api/v1/mentor/avans', token, AVANS).expect(201);
      const id = dataOf<AvansBody>(created).id;

      await post('/api/v1/mentor/avans', token, AVANS).expect(409);
      await del(`/api/v1/mentor/avans/${id}`, token).expect(200);
      await post('/api/v1/mentor/avans', token, AVANS).expect(201);

      expect(store.requestsOf(employee.id)).toHaveLength(1);
    });

    it('422 на отзыв рассмотренной заявки — она остаётся на месте', async () => {
      const { token, employee } = await mentorWith();
      const approved = store.addRequest(employee.id, { status: AvansStatus.APPROVED });

      await del(`/api/v1/mentor/avans/${approved.id}`, token).expect(422);

      expect(store.requests.has(approved.id)).toBe(true);
    });

    it('404 на чужую заявку — и она не удалена', async () => {
      const mine = await mentorWith({ phone: '+992901111111' });
      const other = await mentorWith({ phone: '+992902222222' });
      const foreign = store.addRequest(other.employee.id);

      await del(`/api/v1/mentor/avans/${foreign.id}`, mine.token).expect(404);

      expect(store.requests.has(foreign.id)).toBe(true);
    });

    it('в списке только свои заявки, свежие сверху', async () => {
      const mine = await mentorWith({ phone: '+992901111111' });
      const other = await mentorWith({ phone: '+992902222222' });
      store.addRequest(mine.employee.id, {
        amount: new Prisma.Decimal('300.00'),
        month: new Date('2026-08-01T00:00:00.000Z'),
      });
      store.addRequest(mine.employee.id, { amount: new Prisma.Decimal('700.00') });
      store.addRequest(other.employee.id, { amount: new Prisma.Decimal('900.00') });

      const response = await get('/api/v1/mentor/avans', mine.token).expect(200);
      const items = dataOf<AvansBody[]>(response);

      expect(metaOf(response).total).toBe(2);
      expect(items.map((row) => row.amount)).toEqual([700, 300]);
    });

    it('фильтр по статусу и период по месяцу зарплаты', async () => {
      const { token, employee } = await mentorWith();
      store.addRequest(employee.id, {
        status: AvansStatus.APPROVED,
        month: new Date('2026-08-01T00:00:00.000Z'),
      });
      store.addRequest(employee.id, { status: AvansStatus.PENDING });

      const approved = await get('/api/v1/mentor/avans?status=APPROVED', token).expect(200);
      expect(dataOf<AvansBody[]>(approved)).toHaveLength(1);

      const period = await get('/api/v1/mentor/avans?from=2026-09&to=2026-09', token).expect(200);
      expect(dataOf<AvansBody[]>(period).map((row) => row.month)).toEqual(['2026-09']);
    });

    it('400 на негодное тело — заявка не заводится', async () => {
      const { token, employee } = await mentorWith();

      await post('/api/v1/mentor/avans', token, { ...AVANS, amount: 0 }).expect(400);
      await post('/api/v1/mentor/avans', token, { ...AVANS, amount: -5 }).expect(400);
      await post('/api/v1/mentor/avans', token, { ...AVANS, month: '2026-13' }).expect(400);
      await post('/api/v1/mentor/avans', token, { ...AVANS, reason: 'ок' }).expect(400);
      await post('/api/v1/mentor/avans', token, { amount: 500, reason: 'Аренда' }).expect(400);
      await post('/api/v1/mentor/avans', token, {
        ...AVANS,
        employeeId: randomUUID(),
      }).expect(400);

      expect(store.requestsOf(employee.id)).toHaveLength(0);
    });

    it('400 на не-UUID в пути отзыва', async () => {
      const { token } = await mentorWith();

      await del('/api/v1/mentor/avans/не-uuid', token).expect(400);
    });

    it('заявка, поданная из кабинета, видна на админ-стороне тем же телом', async () => {
      const { token, employee } = await mentorWith();
      const admin = randomUUID();
      rbac.grant(admin, ['Permission.Avans.Views']);
      const { accessToken } = await tokens.issuePair({
        sub: admin,
        sid: randomUUID(),
        type: AccountType.EMPLOYEE,
      });

      const created = await post('/api/v1/mentor/avans', token, AVANS).expect(201);
      const fromAdmin = await get(`/api/v1/employees/${employee.id}/avans`, accessToken).expect(
        200,
      );

      expect(dataOf<AvansBody[]>(fromAdmin)[0]).toEqual(dataOf<AvansBody>(created));
    });
  });

  // ────────────────────────────── OpenAPI ──────────────────────────────

  describe('OpenAPI', () => {
    it('все шесть маршрутов кабинета описаны в документе', () => {
      const paths = buildOpenApiDocument(app).paths ?? {};

      expect(Object.keys(paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/mentor/profile',
          '/api/v1/mentor/groups',
          '/api/v1/mentor/timetable',
          '/api/v1/mentor/courses',
          '/api/v1/mentor/materials',
          '/api/v1/mentor/avans',
          '/api/v1/mentor/avans/{avansId}',
        ]),
      );
    });

    it('разделы просмотра описаны только как get — кабинет ничего не меняет', () => {
      const paths = buildOpenApiDocument(app).paths ?? {};

      for (const path of [
        '/api/v1/mentor/profile',
        '/api/v1/mentor/groups',
        '/api/v1/mentor/timetable',
        '/api/v1/mentor/courses',
        '/api/v1/mentor/materials',
      ]) {
        expect(Object.keys(paths[path] ?? {})).toEqual(['get']);
      }
    });

    it('подача заявки описана кодом 201 (и не 200), правки заявки нет', () => {
      const paths = buildOpenApiDocument(app).paths ?? {};
      const avans = paths['/api/v1/mentor/avans'] ?? {};

      expect(Object.keys(avans.post?.responses ?? {})).toContain('201');
      expect(Object.keys(avans.post?.responses ?? {})).not.toContain('200');
      expect(Object.keys(paths['/api/v1/mentor/avans/{avansId}'] ?? {})).toEqual(['delete']);
    });
  });
});
