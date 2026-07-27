import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  AccountType,
  DirectoryStatus,
  DurationUnit,
  GroupFormat,
  GroupStatus,
} from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { BranchesModule } from 'src/branches/branches.module';
import { BranchesRepository } from 'src/branches/branches.repository';
import type {
  BranchListParams,
  BranchRow,
  BranchWriteInput,
} from 'src/branches/branches.repository';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { CoursesModule } from 'src/courses/courses.module';
import { CoursesRepository } from 'src/courses/courses.repository';
import type { CourseListParams, CourseRow, CourseWriteInput } from 'src/courses/courses.repository';
import { GraduatesRepository } from 'src/graduates/graduates.repository';
import { GroupsModule } from 'src/groups/groups.module';
import { GroupsRepository } from 'src/groups/groups.repository';
import type { GroupListParams, GroupRow, GroupWriteInput } from 'src/groups/groups.repository';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { PhoneModule } from 'src/phone/phone.module';
import { RbacModule } from 'src/rbac/rbac.module';
import { RbacRepository } from 'src/rbac/rbac.repository';
import { RoomsModule } from 'src/rooms/rooms.module';
import { RoomsRepository } from 'src/rooms/rooms.repository';
import type { RoomListParams, RoomRow, RoomWriteInput } from 'src/rooms/rooms.repository';
import { buildOpenApiDocument } from 'src/swagger';

/** `{ data }` ответа с ожидаемым типом — тела supertest типизированы как `any`. */
const dataOf = <T>(response: { body: unknown }): T => (response.body as { data: T }).data;

/**
 * Права аккаунта в памяти вместо трёх таблиц RBAC. Каталог не сверяется:
 * этот набор проверяется в `rbac.e2e-spec.ts`, здесь нужен только сам факт
 * «есть право / нет права» на настоящем `PermissionsGuard`.
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

/**
 * Справочники учебного контура в памяти. Все четыре сущности живут в одном
 * хранилище, потому что связаны: аудитория и группа ссылаются на филиал,
 * группа — ещё и на курс, а счётчики филиала и курса считают эти ссылки.
 * Несогласованные заглушки проверяли бы не то поведение, которое даёт БД.
 */
class InMemoryCatalogStore {
  readonly branches = new Map<string, BranchRow>();
  readonly rooms = new Map<string, RoomRow>();
  readonly courses = new Map<string, CourseRow>();
  readonly groups = new Map<string, GroupRow>();
  /** Сколько всего членств у группы — на это упирается её удаление (ТЗ 5.5). */
  private readonly groupStudentCounts = new Map<string, number>();

  /** Люди, закреплённые за филиалом: нужны только как счётчики в карточке. */
  private readonly people = new Map<string, { students: number; employees: number }>();

  addBranch(overrides: Partial<BranchRow> = {}): BranchRow {
    const branch: BranchRow = {
      id: randomUUID(),
      name: `Branch-${String(this.branches.size)}`,
      city: 'Душанбе',
      district: null,
      address: 'ул. Рудаки, 105',
      phone: null,
      description: null,
      status: DirectoryStatus.ACTIVE,
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
      _count: { rooms: 0, groups: 0, students: 0, employees: 0 },
      ...overrides,
    };
    this.branches.set(branch.id, branch);

    return branch;
  }

  attachPeople(branchId: string, students: number, employees: number): void {
    this.people.set(branchId, { students, employees });
  }

  addRoom(branchId: string, name: string, overrides: Partial<RoomRow> = {}): RoomRow {
    const branch = this.branchOrThrow(branchId);
    const room: RoomRow = {
      id: randomUUID(),
      name,
      branch: { id: branch.id, name: branch.name },
      capacity: null,
      floor: null,
      description: null,
      status: DirectoryStatus.ACTIVE,
      createdAt: new Date('2026-07-21T00:00:00.000Z'),
      ...overrides,
    };
    this.rooms.set(room.id, room);

    return room;
  }

  addCourse(title: string, overrides: Partial<CourseRow> = {}): CourseRow {
    const course: CourseRow = {
      id: randomUUID(),
      title,
      subtitle: null,
      description: null,
      // Слой данных подменён, поэтому здесь обычное число: сервис переводит
      // значение через `Number()` именно ради такой подстановки.
      fee: 1200.5 as unknown as CourseRow['fee'],
      isLastCourse: false,
      colorPrimary: null,
      colorSecondary: null,
      logoUrl: null,
      durationValue: 1,
      durationUnit: DurationUnit.MONTH,
      status: DirectoryStatus.ACTIVE,
      createdAt: new Date('2026-07-22T00:00:00.000Z'),
      _count: { groups: 0 },
      ...overrides,
    };
    this.courses.set(course.id, course);

    return course;
  }

  addGroup(
    branchId: string,
    courseId: string,
    name: string,
    overrides: Partial<GroupRow> = {},
  ): GroupRow {
    const branch = this.branchOrThrow(branchId);
    const course = this.courseOrThrow(courseId);
    const group: GroupRow = {
      id: randomUUID(),
      name,
      description: null,
      course: { id: course.id, title: course.title, isLastCourse: course.isLastCourse },
      branch: { id: branch.id, name: branch.name },
      format: GroupFormat.OFFLINE,
      startDate: null,
      endDate: null,
      durationValue: null,
      durationUnit: DurationUnit.MONTH,
      capacity: null,
      status: GroupStatus.RECRUITING,
      telegramUrl: null,
      // Состава у групп в этом наборе нет: он живёт в `group-students.e2e-spec.ts`
      // со своим хранилищем. Здесь важно лишь, что счётчик доезжает до ответа.
      _count: { students: 0 },
      createdAt: new Date('2026-07-23T00:00:00.000Z'),
      ...overrides,
    };
    this.groups.set(group.id, group);

    return group;
  }

  // ─── BranchesRepository ───

  findBranches(params: BranchListParams): Promise<{ rows: BranchRow[]; total: number }> {
    const search = params.search?.toLowerCase();
    const matched = [...this.branches.values()]
      .filter((branch) => params.status === undefined || branch.status === params.status)
      .filter(
        (branch) =>
          search === undefined ||
          [branch.name, branch.city, branch.district ?? '', branch.address].some((field) =>
            field.toLowerCase().includes(search),
          ),
      )
      .map((branch) => this.withCounts(branch));

    // Сравнение со строкой, а не с членом enum: значения приходят из DTO,
    // и eslint справедливо запрещает сравнивать разнородные перечисления.
    const sort: string = params.sort;
    const order: string = params.order;

    matched.sort((a, b) => {
      const asc = sort === 'city' ? a.city.localeCompare(b.city) : a.name.localeCompare(b.name);

      return order === 'asc' ? asc : -asc;
    });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findBranchById(id: string): Promise<BranchRow | null> {
    const branch = this.branches.get(id);

    return Promise.resolve(branch ? this.withCounts(branch) : null);
  }

  findBranchByName(name: string): Promise<{ id: string; name: string } | null> {
    const found = [...this.branches.values()].find(
      (branch) => branch.name.toLowerCase() === name.toLowerCase(),
    );

    return Promise.resolve(found ? { id: found.id, name: found.name } : null);
  }

  createBranch(input: BranchWriteInput): Promise<BranchRow> {
    return Promise.resolve(
      this.addBranch({ ...input, status: input.status ?? DirectoryStatus.ACTIVE }),
    );
  }

  updateBranch(id: string, input: Partial<BranchWriteInput>): Promise<BranchRow> {
    const branch = this.branchOrThrow(id);
    for (const [key, value] of Object.entries(input)) {
      // `undefined` означает «поле не передано» — так же его пропускает Prisma.
      if (value !== undefined) Object.assign(branch, { [key]: value });
    }

    return Promise.resolve(this.withCounts(branch));
  }

  deleteBranch(id: string): Promise<void> {
    this.branches.delete(id);

    return Promise.resolve();
  }

  // ─── RoomsRepository ───

  findRooms(params: RoomListParams): Promise<{ rows: RoomRow[]; total: number }> {
    const search = params.search?.toLowerCase();
    const matched = [...this.rooms.values()]
      .filter((room) => params.branchId === undefined || room.branch.id === params.branchId)
      .filter((room) => params.status === undefined || room.status === params.status)
      .filter(
        (room) =>
          search === undefined ||
          [room.name, room.description ?? '', room.branch.name].some((field) =>
            field.toLowerCase().includes(search),
          ),
      );

    matched.sort((a, b) => a.name.localeCompare(b.name));

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findRoomById(id: string): Promise<RoomRow | null> {
    return Promise.resolve(this.rooms.get(id) ?? null);
  }

  findRoomByName(branchId: string, name: string): Promise<{ id: string; name: string } | null> {
    const found = [...this.rooms.values()].find(
      (room) => room.branch.id === branchId && room.name.toLowerCase() === name.toLowerCase(),
    );

    return Promise.resolve(found ? { id: found.id, name: found.name } : null);
  }

  findBranchShort(id: string): Promise<{ id: string; name: string } | null> {
    const branch = this.branches.get(id);

    return Promise.resolve(branch ? { id: branch.id, name: branch.name } : null);
  }

  createRoom(input: RoomWriteInput): Promise<RoomRow> {
    const { branchId, ...rest } = input;

    return Promise.resolve(
      this.addRoom(branchId, input.name, {
        ...rest,
        status: input.status ?? DirectoryStatus.ACTIVE,
      }),
    );
  }

  updateRoom(id: string, input: Partial<RoomWriteInput>): Promise<RoomRow> {
    const room = this.rooms.get(id);
    if (!room) throw new Error('Аудитории нет: тест построен неверно');

    const { branchId, ...rest } = input;
    if (branchId !== undefined) {
      const branch = this.branchOrThrow(branchId);
      room.branch = { id: branch.id, name: branch.name };
    }
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) Object.assign(room, { [key]: value });
    }

    return Promise.resolve(room);
  }

  deleteRoom(id: string): Promise<void> {
    this.rooms.delete(id);

    return Promise.resolve();
  }

  // ─── CoursesRepository ───

  findCourses(params: CourseListParams): Promise<{ rows: CourseRow[]; total: number }> {
    const search = params.search?.toLowerCase();
    const matched = [...this.courses.values()]
      .filter((course) => params.status === undefined || course.status === params.status)
      .filter(
        (course) =>
          params.isLastCourse === undefined || course.isLastCourse === params.isLastCourse,
      )
      .filter(
        (course) =>
          search === undefined ||
          [course.title, course.subtitle ?? '', course.description ?? ''].some((field) =>
            field.toLowerCase().includes(search),
          ),
      )
      .map((course) => this.withGroupCount(course));

    matched.sort((a, b) => a.title.localeCompare(b.title));

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findCourseById(id: string): Promise<CourseRow | null> {
    const course = this.courses.get(id);

    return Promise.resolve(course ? this.withGroupCount(course) : null);
  }

  findCourseByTitle(title: string): Promise<{ id: string; title: string } | null> {
    const found = [...this.courses.values()].find(
      (course) => course.title.toLowerCase() === title.toLowerCase(),
    );

    return Promise.resolve(found ? { id: found.id, title: found.title } : null);
  }

  createCourse(input: CourseWriteInput): Promise<CourseRow> {
    return Promise.resolve(
      this.addCourse(input.title, {
        ...input,
        fee: input.fee as unknown as CourseRow['fee'],
        isLastCourse: input.isLastCourse ?? false,
        durationUnit: input.durationUnit ?? DurationUnit.MONTH,
        status: input.status ?? DirectoryStatus.ACTIVE,
      }),
    );
  }

  updateCourse(id: string, input: Partial<CourseWriteInput>): Promise<CourseRow> {
    const course = this.courses.get(id);
    if (!course) throw new Error('Курса нет: тест построен неверно');

    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) Object.assign(course, { [key]: value });
    }

    return Promise.resolve(course);
  }

  deleteCourse(id: string): Promise<void> {
    this.courses.delete(id);

    return Promise.resolve();
  }

  // ─── GroupsRepository ───

  findGroups(params: GroupListParams): Promise<{ rows: GroupRow[]; total: number }> {
    const search = params.search?.toLowerCase();
    const matched = [...this.groups.values()]
      .filter((group) => params.branchId === undefined || group.branch.id === params.branchId)
      .filter((group) => params.courseId === undefined || group.course.id === params.courseId)
      .filter((group) => params.status === undefined || group.status === params.status)
      .filter((group) => params.format === undefined || group.format === params.format)
      .filter(
        (group) =>
          search === undefined ||
          [group.name, group.description ?? '', group.course.title, group.branch.name].some(
            (field) => field.toLowerCase().includes(search),
          ),
      );

    matched.sort((a, b) => a.name.localeCompare(b.name));

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findGroupById(id: string): Promise<GroupRow | null> {
    return Promise.resolve(this.groups.get(id) ?? null);
  }

  /**
   * Состав группы числом. Сам модуль состава живёт в `group-students.e2e-spec.ts`
   * со своим хранилищем; здесь важно только то, что удаление группы в это число
   * упирается, — и подставить его достаточно.
   */
  enroll(groupId: string, count: number): void {
    this.groupStudentCounts.set(groupId, count);
  }

  countGroupStudents(id: string): Promise<number> {
    return Promise.resolve(this.groupStudentCounts.get(id) ?? 0);
  }

  findGroupByName(branchId: string, name: string): Promise<{ id: string; name: string } | null> {
    const found = [...this.groups.values()].find(
      (group) => group.branch.id === branchId && group.name.toLowerCase() === name.toLowerCase(),
    );

    return Promise.resolve(found ? { id: found.id, name: found.name } : null);
  }

  findCourseShort(id: string): Promise<{ id: string; title: string } | null> {
    const course = this.courses.get(id);

    return Promise.resolve(course ? { id: course.id, title: course.title } : null);
  }

  createGroup(input: GroupWriteInput): Promise<GroupRow> {
    const { branchId, courseId, ...rest } = input;

    return Promise.resolve(
      this.addGroup(branchId, courseId, input.name, {
        ...rest,
        format: input.format ?? GroupFormat.OFFLINE,
        durationUnit: input.durationUnit ?? DurationUnit.MONTH,
        status: input.status ?? GroupStatus.RECRUITING,
      }),
    );
  }

  updateGroup(id: string, input: Partial<GroupWriteInput>): Promise<GroupRow> {
    const group = this.groups.get(id);
    if (!group) throw new Error('Группы нет: тест построен неверно');

    const { branchId, courseId, ...rest } = input;
    if (branchId !== undefined) {
      const branch = this.branchOrThrow(branchId);
      group.branch = { id: branch.id, name: branch.name };
    }
    if (courseId !== undefined) {
      const course = this.courseOrThrow(courseId);
      group.course = { id: course.id, title: course.title, isLastCourse: course.isLastCourse };
    }
    for (const [key, value] of Object.entries(rest)) {
      // `undefined` означает «поле не передано» — так же его пропускает Prisma.
      if (value !== undefined) Object.assign(group, { [key]: value });
    }

    return Promise.resolve(group);
  }

  deleteGroup(id: string): Promise<void> {
    this.groups.delete(id);

    return Promise.resolve();
  }

  // ─── Вспомогательное ───

  private branchOrThrow(id: string): BranchRow {
    const branch = this.branches.get(id);
    if (!branch) throw new Error('Филиала нет: тест построен неверно');

    return branch;
  }

  private courseOrThrow(id: string): CourseRow {
    const course = this.courses.get(id);
    if (!course) throw new Error('Курса нет: тест построен неверно');

    return course;
  }

  /** Счётчики считаются на лету — как `_count` в настоящем запросе. */
  private withCounts(branch: BranchRow): BranchRow {
    const people = this.people.get(branch.id) ?? { students: 0, employees: 0 };
    branch._count = {
      rooms: [...this.rooms.values()].filter((room) => room.branch.id === branch.id).length,
      groups: [...this.groups.values()].filter((group) => group.branch.id === branch.id).length,
      students: people.students,
      employees: people.employees,
    };

    return branch;
  }

  /** «Кол-во групп» курса (ТЗ 5.6) — тот же `_count`, только по другой связи. */
  private withGroupCount(course: CourseRow): CourseRow {
    course._count = {
      groups: [...this.groups.values()].filter((group) => group.course.id === course.id).length,
    };

    return course;
  }
}

interface BranchBody {
  id: string;
  name: string;
  city: string;
  district: string | null;
  phone: string | null;
  status: DirectoryStatus;
  roomsCount: number;
  groupsCount: number;
  studentsCount: number;
  employeesCount: number;
}

interface RoomBody {
  id: string;
  name: string;
  branch: { id: string; name: string };
  capacity: number | null;
}

interface CourseBody {
  id: string;
  title: string;
  fee: number;
  isLastCourse: boolean;
  durationValue: number;
  durationUnit: DurationUnit;
  groupsCount: number;
}

interface GroupBody {
  id: string;
  name: string;
  description: string | null;
  course: { id: string; title: string; isLastCourse: boolean };
  branch: { id: string; name: string };
  format: GroupFormat;
  startDate: string | null;
  endDate: string | null;
  durationValue: number | null;
  capacity: number | null;
  status: GroupStatus;
  telegramUrl: string | null;
}

describe('Справочники учебного контура (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryCatalogStore;
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
    (
      await tokens.issuePair({
        sub: randomUUID(),
        sid: randomUUID(),
        type: AccountType.STUDENT,
      })
    ).accessToken;

  beforeEach(async () => {
    store = new InMemoryCatalogStore();
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
        BranchesModule,
        RoomsModule,
        CoursesModule,
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
      // Репозитории объявляют одноимённые методы с разным смыслом, поэтому
      // в хранилище они названы по сущности, а здесь разводятся переходниками.
      .overrideProvider(BranchesRepository)
      .useValue({
        findMany: (params: BranchListParams) => store.findBranches(params),
        findById: (id: string) => store.findBranchById(id),
        findByName: (name: string) => store.findBranchByName(name),
        create: (input: BranchWriteInput) => store.createBranch(input),
        update: (id: string, input: Partial<BranchWriteInput>) => store.updateBranch(id, input),
        delete: (id: string) => store.deleteBranch(id),
      })
      .overrideProvider(RoomsRepository)
      .useValue({
        findMany: (params: RoomListParams) => store.findRooms(params),
        findById: (id: string) => store.findRoomById(id),
        findByName: (branchId: string, name: string) => store.findRoomByName(branchId, name),
        findBranch: (id: string) => store.findBranchShort(id),
        // Расписания в этом наборе нет — правило «аудиторию с занятиями
        // не удалить» проверяет `group-schedule.e2e-spec.ts`.
        countScheduleSlots: () => Promise.resolve(0),
        create: (input: RoomWriteInput) => store.createRoom(input),
        update: (id: string, input: Partial<RoomWriteInput>) => store.updateRoom(id, input),
        delete: (id: string) => store.deleteRoom(id),
      })
      .overrideProvider(CoursesRepository)
      .useValue({
        findMany: (params: CourseListParams) => store.findCourses(params),
        findById: (id: string) => store.findCourseById(id),
        findByTitle: (title: string) => store.findCourseByTitle(title),
        create: (input: CourseWriteInput) => store.createCourse(input),
        update: (id: string, input: Partial<CourseWriteInput>) => store.updateCourse(id, input),
        delete: (id: string) => store.deleteCourse(id),
      })
      .overrideProvider(GroupsRepository)
      .useValue({
        findMany: (params: GroupListParams) => store.findGroups(params),
        findById: (id: string) => store.findGroupById(id),
        findByName: (branchId: string, name: string) => store.findGroupByName(branchId, name),
        findBranch: (id: string) => store.findBranchShort(id),
        findCourse: (id: string) => store.findCourseShort(id),
        // Тоже расписание: перенос группы в другой филиал упирается в занятия
        // в аудиториях, и это проверяет `group-schedule.e2e-spec.ts`.
        countScheduleSlotsWithRoom: () => Promise.resolve(0),
        countStudents: (id: string) => store.countGroupStudents(id),
        // Выпускников в этом наборе нет — их и автовыпуск (ТЗ 5.11) проверяет
        // `graduates.e2e-spec.ts`, где живут журнал, состав и записи выпуска.
        countGraduates: () => Promise.resolve(0),
        // Журнала в этом наборе нет, поэтому счётчики категорий выходят
        // нулевыми: их проверяет `performance.e2e-spec.ts`, где есть недели.
        findActivity: () => Promise.resolve({ members: [], results: [] }),
        create: (input: GroupWriteInput) => store.createGroup(input),
        update: (id: string, input: Partial<GroupWriteInput>) => store.updateGroup(id, input),
        delete: (id: string) => store.deleteGroup(id),
      })
      .overrideProvider(GraduatesRepository)
      .useValue({
        // `GroupsModule` импортирует `GraduatesModule` ради автовыпуска.
        // Здесь он всегда «нечего выпускать»: группы этого набора живут
        // без состава и без журнала.
        findGroupForGraduation: () => Promise.resolve(null),
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

  describe('Доступ', () => {
    it('без токена — 401 на каждый справочник', async () => {
      const server = app.getHttpServer();

      await request(server).get('/api/v1/branches').expect(401);
      await request(server).get('/api/v1/rooms').expect(401);
      await request(server).get('/api/v1/courses').expect(401);
      await request(server).get('/api/v1/groups').expect(401);
    });

    it('студент не ведёт справочники — 403 (ТЗ 3.2)', async () => {
      const token = await studentToken();

      await get('/api/v1/branches', token).expect(403);
      await get('/api/v1/rooms', token).expect(403);
      await get('/api/v1/courses', token).expect(403);
      await get('/api/v1/groups', token).expect(403);
    });

    it('сотрудник без прав — 403', async () => {
      const response = await get('/api/v1/branches', await actor()).expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('право на просмотр не даёт права на создание', async () => {
      const token = await actor('Permission.Branches.Views');

      await get('/api/v1/branches', token).expect(200);
      await send('post', '/api/v1/branches', token, {
        name: 'Sadbarg',
        city: 'Душанбе',
        address: 'ул. Рудаки, 105',
      }).expect(403);
    });

    it('право на филиалы не открывает курсы, аудитории и группы', async () => {
      const token = await actor('Permission.Branches.Views');

      await get('/api/v1/rooms', token).expect(403);
      await get('/api/v1/courses', token).expect(403);
      await get('/api/v1/groups', token).expect(403);
    });
  });

  describe('Филиалы (ТЗ 5.17)', () => {
    it('создаёт филиал, нормализует телефон и отдаёт счётчики', async () => {
      const token = await actor('Permission.Branches.Create');

      const response = await send('post', '/api/v1/branches', token, {
        name: 'Sadbarg',
        city: 'Душанбе',
        district: 'Сино',
        address: 'ул. Рудаки, 105',
        phone: '901234567',
      }).expect(201);

      expect(dataOf<BranchBody>(response)).toMatchObject({
        name: 'Sadbarg',
        district: 'Сино',
        phone: '+992901234567',
        status: DirectoryStatus.ACTIVE,
        roomsCount: 0,
        studentsCount: 0,
        employeesCount: 0,
      });
    });

    it('список отдаёт { data, meta } и фильтруется по статусу', async () => {
      const token = await actor('Permission.Branches.Views');
      store.addBranch({ name: 'Sadbarg' });
      store.addBranch({ name: 'Profsous', status: DirectoryStatus.INACTIVE });

      const all = await get('/api/v1/branches', token).expect(200);
      expect(all.body.meta).toMatchObject({ total: 2, page: 1, limit: 20 });

      const active = await get(`/api/v1/branches?status=${DirectoryStatus.ACTIVE}`, token).expect(
        200,
      );
      expect(active.body.meta.total).toBe(1);
      expect(dataOf<BranchBody[]>(active)[0]?.name).toBe('Sadbarg');
    });

    it('счётчик аудиторий виден в карточке филиала', async () => {
      const token = await actor('Permission.Branches.Views');
      const branch = store.addBranch({ name: 'Sadbarg' });
      store.addRoom(branch.id, '101');
      store.addRoom(branch.id, '102');

      const response = await get(`/api/v1/branches/${branch.id}`, token).expect(200);

      expect(dataOf<BranchBody>(response).roomsCount).toBe(2);
    });

    it('409 на филиал-тёзку без учёта регистра', async () => {
      const token = await actor('Permission.Branches.Create');
      store.addBranch({ name: 'Sadbarg' });

      const response = await send('post', '/api/v1/branches', token, {
        name: 'sadbarg',
        city: 'Душанбе',
        address: 'ул. Рудаки, 105',
      }).expect(409);

      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('400 на неразбираемый телефон и на лишнее поле', async () => {
      const token = await actor('Permission.Branches.Create');

      await send('post', '/api/v1/branches', token, {
        name: 'Profsous',
        city: 'Худжанд',
        address: 'ул. Ленина, 1',
        phone: '12',
      }).expect(400);

      await send('post', '/api/v1/branches', token, {
        name: 'Profsous',
        city: 'Худжанд',
        address: 'ул. Ленина, 1',
        unexpected: true,
      }).expect(400);
    });

    it('PUT меняет переданное и очищает поле пустой строкой', async () => {
      const token = await actor('Permission.Branches.Update');
      const branch = store.addBranch({ name: 'Sadbarg', district: 'Сино', city: 'Душанбе' });

      const response = await send('put', `/api/v1/branches/${branch.id}`, token, {
        district: '',
      }).expect(200);

      const body = dataOf<BranchBody>(response);
      expect(body.district).toBeNull();
      // Не переданный город остался прежним.
      expect(body.city).toBe('Душанбе');
    });

    it('409 на удаление филиала с аудиториями и со студентами', async () => {
      const token = await actor('Permission.Branches.Delete');
      const withRooms = store.addBranch({ name: 'Sadbarg' });
      store.addRoom(withRooms.id, '101');

      const withPeople = store.addBranch({ name: 'Profsous' });
      store.attachPeople(withPeople.id, 15, 0);

      const rooms = await send('delete', `/api/v1/branches/${withRooms.id}`, token).expect(409);
      expect(rooms.body.error.message).toContain('аудитории (1)');

      const people = await send('delete', `/api/v1/branches/${withPeople.id}`, token).expect(409);
      expect(people.body.error.message).toContain('студенты (15)');

      expect(store.branches.has(withRooms.id)).toBe(true);
      expect(store.branches.has(withPeople.id)).toBe(true);
    });

    it('409 на удаление филиала, в котором набраны группы', async () => {
      const token = await actor('Permission.Branches.Delete');
      const branch = store.addBranch({ name: 'Sadbarg' });
      const course = store.addCourse('Frontend Basic');
      store.addGroup(branch.id, course.id, 'Frontend-1');

      const response = await send('delete', `/api/v1/branches/${branch.id}`, token).expect(409);

      expect(response.body.error.message).toContain('группы (1)');
      expect(store.branches.has(branch.id)).toBe(true);
    });

    it('счётчик групп виден в карточке филиала', async () => {
      const token = await actor('Permission.Branches.Views');
      const branch = store.addBranch({ name: 'Sadbarg' });
      const course = store.addCourse('Frontend Basic');
      store.addGroup(branch.id, course.id, 'Frontend-1');
      store.addGroup(branch.id, course.id, 'Frontend-2');

      const response = await get(`/api/v1/branches/${branch.id}`, token).expect(200);

      expect(dataOf<BranchBody>(response).groupsCount).toBe(2);
    });

    it('удаляет пустой филиал', async () => {
      const token = await actor('Permission.Branches.Delete');
      const branch = store.addBranch({ name: 'Temp' });

      const response = await send('delete', `/api/v1/branches/${branch.id}`, token).expect(200);

      expect(response.body.data).toEqual({ id: branch.id, name: 'Temp' });
      expect(store.branches.has(branch.id)).toBe(false);
    });

    it('404 на неизвестный филиал и 400 на не-UUID', async () => {
      const token = await actor('Permission.Branches.Views');

      await get(`/api/v1/branches/${randomUUID()}`, token).expect(404);
      await get('/api/v1/branches/не-uuid', token).expect(400);
    });
  });

  describe('Аудитории (ТЗ 5.10)', () => {
    it('создаёт аудиторию и отдаёт её вместе с филиалом', async () => {
      const token = await actor('Permission.Rooms.Create');
      const branch = store.addBranch({ name: 'Sadbarg' });

      const response = await send('post', '/api/v1/rooms', token, {
        branchId: branch.id,
        name: '101',
        capacity: 16,
        floor: 1,
      }).expect(201);

      expect(dataOf<RoomBody>(response)).toMatchObject({
        name: '101',
        branch: { id: branch.id, name: 'Sadbarg' },
        capacity: 16,
      });
    });

    it('422 на несуществующий филиал в теле запроса', async () => {
      const token = await actor('Permission.Rooms.Create');

      const response = await send('post', '/api/v1/rooms', token, {
        branchId: randomUUID(),
        name: '101',
      }).expect(422);

      expect(response.body.error.code).toBe('UNPROCESSABLE_ENTITY');
    });

    it('409 на тёзку в том же филиале, но не в соседнем', async () => {
      const token = await actor('Permission.Rooms.Create');
      const first = store.addBranch({ name: 'Sadbarg' });
      const second = store.addBranch({ name: 'Profsous' });
      store.addRoom(first.id, '101');

      await send('post', '/api/v1/rooms', token, { branchId: first.id, name: '101' }).expect(409);
      // Та же «101» в другом филиале — обычное дело.
      await send('post', '/api/v1/rooms', token, { branchId: second.id, name: '101' }).expect(201);
    });

    it('фильтр по филиалу отдаёт только его аудитории', async () => {
      const token = await actor('Permission.Rooms.Views');
      const first = store.addBranch({ name: 'Sadbarg' });
      const second = store.addBranch({ name: 'Profsous' });
      store.addRoom(first.id, '101');
      store.addRoom(first.id, '102');
      store.addRoom(second.id, '201');

      const response = await get(`/api/v1/rooms?branchId=${first.id}`, token).expect(200);

      expect(response.body.meta.total).toBe(2);
      expect(dataOf<RoomBody[]>(response).map((room) => room.name)).toEqual(['101', '102']);
    });

    it('переносит аудиторию в другой филиал', async () => {
      const token = await actor('Permission.Rooms.Update');
      const first = store.addBranch({ name: 'Sadbarg' });
      const second = store.addBranch({ name: 'Profsous' });
      const room = store.addRoom(first.id, '101');

      const response = await send('put', `/api/v1/rooms/${room.id}`, token, {
        branchId: second.id,
      }).expect(200);

      expect(dataOf<RoomBody>(response).branch).toEqual({ id: second.id, name: 'Profsous' });
    });

    it('409 на перенос, если в филиале назначения такая аудитория уже есть', async () => {
      const token = await actor('Permission.Rooms.Update');
      const first = store.addBranch({ name: 'Sadbarg' });
      const second = store.addBranch({ name: 'Profsous' });
      const room = store.addRoom(first.id, '101');
      store.addRoom(second.id, '101');

      await send('put', `/api/v1/rooms/${room.id}`, token, { branchId: second.id }).expect(409);
      expect(store.rooms.get(room.id)?.branch.id).toBe(first.id);
    });

    it('400 на вместимость за границей допустимого', async () => {
      const token = await actor('Permission.Rooms.Create');
      const branch = store.addBranch({ name: 'Sadbarg' });

      await send('post', '/api/v1/rooms', token, {
        branchId: branch.id,
        name: '101',
        capacity: 0,
      }).expect(400);

      await send('post', '/api/v1/rooms', token, {
        branchId: branch.id,
        name: '102',
        capacity: 100000,
      }).expect(400);
    });

    it('удаляет аудиторию; 404 на неизвестную', async () => {
      const token = await actor('Permission.Rooms.Delete');
      const branch = store.addBranch({ name: 'Sadbarg' });
      const room = store.addRoom(branch.id, '101');

      await send('delete', `/api/v1/rooms/${room.id}`, token).expect(200);
      expect(store.rooms.has(room.id)).toBe(false);

      await send('delete', `/api/v1/rooms/${randomUUID()}`, token).expect(404);
    });
  });

  describe('Курсы (ТЗ 5.6)', () => {
    it('создаёт курс со стоимостью, длительностью и флагом последнего курса', async () => {
      const token = await actor('Permission.Courses.Create');

      const response = await send('post', '/api/v1/courses', token, {
        title: 'Frontend Basic',
        subtitle: 'HTML, CSS и вёрстка',
        fee: 1200.5,
        durationValue: 1,
        durationUnit: DurationUnit.MONTH,
        isLastCourse: true,
        colorPrimary: '#1E88E5',
      }).expect(201);

      expect(dataOf<CourseBody>(response)).toMatchObject({
        title: 'Frontend Basic',
        fee: 1200.5,
        isLastCourse: true,
        durationValue: 1,
        durationUnit: DurationUnit.MONTH,
      });
    });

    it('стоимость отдаётся числом, а не строкой', async () => {
      const token = await actor('Permission.Courses.Views');
      store.addCourse('Frontend Basic');

      const response = await get('/api/v1/courses', token).expect(200);

      expect(typeof dataOf<CourseBody[]>(response)[0]?.fee).toBe('number');
    });

    it('400 на стоимость с тремя знаками после запятой и на отрицательную', async () => {
      const token = await actor('Permission.Courses.Create');

      await send('post', '/api/v1/courses', token, {
        title: 'Backend Basic',
        fee: 1200.555,
        durationValue: 1,
      }).expect(400);

      await send('post', '/api/v1/courses', token, {
        title: 'Backend Basic',
        fee: -1,
        durationValue: 1,
      }).expect(400);
    });

    it('400 на цвет не в формате #RRGGBB', async () => {
      const token = await actor('Permission.Courses.Create');

      const response = await send('post', '/api/v1/courses', token, {
        title: 'Backend Basic',
        fee: 1500,
        durationValue: 1,
        colorPrimary: 'синий',
      }).expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('409 на курс-тёзку без учёта регистра', async () => {
      const token = await actor('Permission.Courses.Create');
      store.addCourse('Frontend Basic');

      await send('post', '/api/v1/courses', token, {
        title: 'frontend basic',
        fee: 1200,
        durationValue: 1,
      }).expect(409);
    });

    it('фильтр isLastCourse отбирает курсы-триггеры автовыпуска (ТЗ 5.11)', async () => {
      const token = await actor('Permission.Courses.Views');
      store.addCourse('Frontend Basic');
      store.addCourse('Frontend Advanced', { isLastCourse: true });

      const response = await get('/api/v1/courses?isLastCourse=true', token).expect(200);

      expect(response.body.meta.total).toBe(1);
      expect(dataOf<CourseBody[]>(response)[0]?.title).toBe('Frontend Advanced');
    });

    it('PUT меняет стоимость и снимает флаг последнего курса', async () => {
      const token = await actor('Permission.Courses.Update');
      const course = store.addCourse('Frontend Advanced', { isLastCourse: true });

      const response = await send('put', `/api/v1/courses/${course.id}`, token, {
        fee: 1400,
        isLastCourse: false,
      }).expect(200);

      expect(dataOf<CourseBody>(response)).toMatchObject({ fee: 1400, isLastCourse: false });
    });

    it('отдаёт «кол-во групп» курса (ТЗ 5.6)', async () => {
      const token = await actor('Permission.Courses.Views');
      const branch = store.addBranch({ name: 'Sadbarg' });
      const course = store.addCourse('Frontend Basic');
      store.addGroup(branch.id, course.id, 'Frontend-1');
      store.addGroup(branch.id, course.id, 'Frontend-2');
      store.addCourse('Backend Basic');

      const response = await get('/api/v1/courses', token).expect(200);

      const byTitle = new Map(
        dataOf<CourseBody[]>(response).map((item) => [item.title, item.groupsCount]),
      );
      expect(byTitle.get('Frontend Basic')).toBe(2);
      expect(byTitle.get('Backend Basic')).toBe(0);
    });

    it('удаляет курс; 404 на неизвестный', async () => {
      const token = await actor('Permission.Courses.Delete');
      const course = store.addCourse('Temp');

      const response = await send('delete', `/api/v1/courses/${course.id}`, token).expect(200);
      expect(response.body.data).toEqual({ id: course.id, title: 'Temp' });

      await send('delete', `/api/v1/courses/${randomUUID()}`, token).expect(404);
    });

    it('409 на удаление курса, по которому учатся группы', async () => {
      const token = await actor('Permission.Courses.Delete');
      const branch = store.addBranch({ name: 'Sadbarg' });
      const course = store.addCourse('Frontend Basic');
      store.addGroup(branch.id, course.id, 'Frontend-1');

      const response = await send('delete', `/api/v1/courses/${course.id}`, token).expect(409);

      expect(response.body.error.code).toBe('CONFLICT');
      expect(store.courses.has(course.id)).toBe(true);
    });
  });

  describe('Группы (ТЗ 5.5)', () => {
    /** Филиал и курс, на которые ссылается группа: без них её не создать. */
    const scene = (): { branchId: string; courseId: string } => {
      const branch = store.addBranch({ name: 'Sadbarg' });
      const course = store.addCourse('Frontend Basic');

      return { branchId: branch.id, courseId: course.id };
    };

    it('создаёт группу с курсом, филиалом, сроками и вместимостью', async () => {
      const token = await actor('Permission.Groups.Create');
      const { branchId, courseId } = scene();

      const response = await send('post', '/api/v1/groups', token, {
        name: 'Frontend-1',
        courseId,
        branchId,
        format: GroupFormat.ONLINE,
        startDate: '2026-09-01',
        endDate: '2026-09-30',
        durationValue: 1,
        durationUnit: DurationUnit.MONTH,
        capacity: 16,
        telegramUrl: 'https://t.me/omuz_frontend_1',
      }).expect(201);

      expect(dataOf<GroupBody>(response)).toMatchObject({
        name: 'Frontend-1',
        course: { id: courseId, title: 'Frontend Basic', isLastCourse: false },
        branch: { id: branchId, name: 'Sadbarg' },
        format: GroupFormat.ONLINE,
        startDate: '2026-09-01',
        endDate: '2026-09-30',
        capacity: 16,
        status: GroupStatus.RECRUITING,
      });
    });

    it('даты отдаются как YYYY-MM-DD, без времени', async () => {
      const token = await actor('Permission.Groups.Create');
      const { branchId, courseId } = scene();

      const response = await send('post', '/api/v1/groups', token, {
        name: 'Frontend-1',
        courseId,
        branchId,
        startDate: '2026-09-01',
      }).expect(201);

      expect(dataOf<GroupBody>(response).startDate).toBe('2026-09-01');
    });

    it('422 на несуществующий курс и на несуществующий филиал в теле', async () => {
      const token = await actor('Permission.Groups.Create');
      const { branchId, courseId } = scene();

      const noCourse = await send('post', '/api/v1/groups', token, {
        name: 'Frontend-1',
        courseId: randomUUID(),
        branchId,
      }).expect(422);
      expect(noCourse.body.error.code).toBe('UNPROCESSABLE_ENTITY');

      await send('post', '/api/v1/groups', token, {
        name: 'Frontend-1',
        courseId,
        branchId: randomUUID(),
      }).expect(422);
    });

    it('409 на тёзку в том же филиале, но не в соседнем', async () => {
      const token = await actor('Permission.Groups.Create');
      const { branchId, courseId } = scene();
      const other = store.addBranch({ name: 'Profsous' });
      store.addGroup(branchId, courseId, 'Frontend-1');

      // Регистр не спасает: «frontend-1» человек читает как ту же группу.
      await send('post', '/api/v1/groups', token, {
        name: 'frontend-1',
        courseId,
        branchId,
      }).expect(409);

      await send('post', '/api/v1/groups', token, {
        name: 'Frontend-1',
        courseId,
        branchId: other.id,
      }).expect(201);
    });

    it('400 на дату окончания раньше даты начала', async () => {
      const token = await actor('Permission.Groups.Create');
      const { branchId, courseId } = scene();

      const response = await send('post', '/api/v1/groups', token, {
        name: 'Frontend-1',
        courseId,
        branchId,
        startDate: '2026-09-30',
        endDate: '2026-09-01',
      }).expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('400 на несуществующую дату, неверный формат и лишнее поле', async () => {
      const token = await actor('Permission.Groups.Create');
      const { branchId, courseId } = scene();
      const base = { name: 'Frontend-1', courseId, branchId };

      await send('post', '/api/v1/groups', token, { ...base, startDate: '2026-02-30' }).expect(400);
      await send('post', '/api/v1/groups', token, { ...base, startDate: '01.09.2026' }).expect(400);
      await send('post', '/api/v1/groups', token, { ...base, unexpected: true }).expect(400);
    });

    it('400 на единицу длительности без значения и на вместимость вне границ', async () => {
      const token = await actor('Permission.Groups.Create');
      const { branchId, courseId } = scene();
      const base = { name: 'Frontend-1', courseId, branchId };

      await send('post', '/api/v1/groups', token, {
        ...base,
        durationUnit: DurationUnit.WEEK,
      }).expect(400);

      await send('post', '/api/v1/groups', token, { ...base, capacity: 0 }).expect(400);
      await send('post', '/api/v1/groups', token, { ...base, capacity: 1000 }).expect(400);
    });

    it('фильтры Branch / Course / Status отбирают группы (ТЗ 5.5)', async () => {
      const token = await actor('Permission.Groups.Views');
      const { branchId, courseId } = scene();
      const other = store.addBranch({ name: 'Profsous' });
      const advanced = store.addCourse('Frontend Advanced', { isLastCourse: true });

      store.addGroup(branchId, courseId, 'Frontend-1');
      store.addGroup(branchId, advanced.id, 'Advanced-1', { status: GroupStatus.ACTIVE });
      store.addGroup(other.id, courseId, 'Frontend-2');

      const byBranch = await get(`/api/v1/groups?branchId=${branchId}`, token).expect(200);
      expect(byBranch.body.meta.total).toBe(2);

      const byCourse = await get(`/api/v1/groups?courseId=${advanced.id}`, token).expect(200);
      expect(dataOf<GroupBody[]>(byCourse).map((group) => group.name)).toEqual(['Advanced-1']);

      const byStatus = await get(`/api/v1/groups?status=${GroupStatus.ACTIVE}`, token).expect(200);
      expect(byStatus.body.meta.total).toBe(1);
    });

    it('список отдаёт { data, meta } и флаг «Is last course» курса (ТЗ 5.11)', async () => {
      const token = await actor('Permission.Groups.Views');
      const { branchId } = scene();
      const last = store.addCourse('Frontend Advanced', { isLastCourse: true });
      store.addGroup(branchId, last.id, 'Advanced-1');

      const response = await get('/api/v1/groups', token).expect(200);

      expect(response.body.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(dataOf<GroupBody[]>(response)[0]?.course.isLastCourse).toBe(true);
    });

    it('переносит группу в другой филиал и на другой курс', async () => {
      const token = await actor('Permission.Groups.Update');
      const { branchId, courseId } = scene();
      const other = store.addBranch({ name: 'Profsous' });
      const advanced = store.addCourse('Frontend Advanced');
      const group = store.addGroup(branchId, courseId, 'Frontend-1');

      const response = await send('put', `/api/v1/groups/${group.id}`, token, {
        branchId: other.id,
        courseId: advanced.id,
      }).expect(200);

      expect(dataOf<GroupBody>(response)).toMatchObject({
        branch: { id: other.id, name: 'Profsous' },
        course: { id: advanced.id, title: 'Frontend Advanced' },
      });
    });

    it('409 на перенос, если в филиале назначения такая группа уже есть', async () => {
      const token = await actor('Permission.Groups.Update');
      const { branchId, courseId } = scene();
      const other = store.addBranch({ name: 'Profsous' });
      const group = store.addGroup(branchId, courseId, 'Frontend-1');
      store.addGroup(other.id, courseId, 'Frontend-1');

      await send('put', `/api/v1/groups/${group.id}`, token, { branchId: other.id }).expect(409);
      expect(store.groups.get(group.id)?.branch.id).toBe(branchId);
    });

    it('PUT меняет статус и очищает дату пустой строкой', async () => {
      const token = await actor('Permission.Groups.Update');
      const { branchId, courseId } = scene();
      const group = store.addGroup(branchId, courseId, 'Frontend-1', {
        startDate: new Date('2026-09-01T00:00:00.000Z'),
        capacity: 16,
      });

      const response = await send('put', `/api/v1/groups/${group.id}`, token, {
        status: GroupStatus.ACTIVE,
        startDate: '',
      }).expect(200);

      const body = dataOf<GroupBody>(response);
      expect(body.status).toBe(GroupStatus.ACTIVE);
      expect(body.startDate).toBeNull();
      // Не переданная вместимость осталась прежней.
      expect(body.capacity).toBe(16);
    });

    it('400, если новая дата окончания раньше даты начала, лежащей в БД', async () => {
      const token = await actor('Permission.Groups.Update');
      const { branchId, courseId } = scene();
      const group = store.addGroup(branchId, courseId, 'Frontend-1', {
        startDate: new Date('2026-09-01T00:00:00.000Z'),
      });

      await send('put', `/api/v1/groups/${group.id}`, token, { endDate: '2026-08-01' }).expect(400);
    });

    it('право на просмотр групп не даёт права на создание', async () => {
      const token = await actor('Permission.Groups.Views');
      const { branchId, courseId } = scene();

      await get('/api/v1/groups', token).expect(200);
      await send('post', '/api/v1/groups', token, {
        name: 'Frontend-1',
        courseId,
        branchId,
      }).expect(403);
    });

    it('удаляет группу; 404 на неизвестную, 400 на не-UUID', async () => {
      const token = await actor('Permission.Groups.Delete');
      const { branchId, courseId } = scene();
      const group = store.addGroup(branchId, courseId, 'Frontend-1');

      const response = await send('delete', `/api/v1/groups/${group.id}`, token).expect(200);
      expect(response.body.data).toEqual({ id: group.id, name: 'Frontend-1' });
      expect(store.groups.has(group.id)).toBe(false);

      await send('delete', `/api/v1/groups/${randomUUID()}`, token).expect(404);
      await send('delete', '/api/v1/groups/не-uuid', token).expect(400);
    });

    it('удаление группы освобождает курс и филиал', async () => {
      const groups = await actor('Permission.Groups.Delete');
      const courses = await actor('Permission.Courses.Delete');
      const { branchId, courseId } = scene();
      const group = store.addGroup(branchId, courseId, 'Frontend-1');

      await send('delete', `/api/v1/courses/${courseId}`, courses).expect(409);
      await send('delete', `/api/v1/groups/${group.id}`, groups).expect(200);
      await send('delete', `/api/v1/courses/${courseId}`, courses).expect(200);
    });

    it('409 на удаление группы с составом — с числом студентов в сообщении', async () => {
      const token = await actor('Permission.Groups.Delete');
      const { branchId, courseId } = scene();
      const group = store.addGroup(branchId, courseId, 'Frontend-1');
      store.enroll(group.id, 12);

      const response = await send('delete', `/api/v1/groups/${group.id}`, token).expect(409);

      expect(response.body.error.message).toContain('(12)');
      expect(store.groups.has(group.id)).toBe(true);
    });

    it('«набрано» отдаётся рядом с вместимостью в списке групп (ТЗ 5.5)', async () => {
      const token = await actor('Permission.Groups.Views');
      const { branchId, courseId } = scene();
      store.addGroup(branchId, courseId, 'Frontend-1', {
        capacity: 16,
        _count: { students: 12 },
      });

      const response = await get('/api/v1/groups', token).expect(200);
      const body = response.body as { data: { capacity: number; enrolledCount: number }[] };

      expect(body.data[0]).toMatchObject({ capacity: 16, enrolledCount: 12 });
    });
  });

  describe('OpenAPI', () => {
    it('документ описывает справочники и код 201 на создание', () => {
      // Документ собирается напрямую: маршрут `/docs/json` монтируется только
      // при `SWAGGER_ENABLED=true`, а в CI Swagger выключен (сессия 0006).
      const document = buildOpenApiDocument(app);

      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/branches',
          '/api/v1/branches/{id}',
          '/api/v1/rooms',
          '/api/v1/rooms/{id}',
          '/api/v1/courses',
          '/api/v1/courses/{id}',
          '/api/v1/groups',
          '/api/v1/groups/{id}',
        ]),
      );

      for (const path of [
        '/api/v1/branches',
        '/api/v1/rooms',
        '/api/v1/courses',
        '/api/v1/groups',
      ]) {
        expect(Object.keys(document.paths[path]?.post?.responses ?? {})).toContain('201');
      }
    });
  });
});
