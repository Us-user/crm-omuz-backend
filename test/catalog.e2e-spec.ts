import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountType, DirectoryStatus, DurationUnit } from '@prisma/client';
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
 * Справочники учебного контура в памяти. Все три живут в одном хранилище,
 * потому что связаны: аудитория ссылается на филиал, а счётчики филиала
 * считают аудитории и людей. Три несогласованные заглушки проверяли бы
 * не то поведение, которое даёт настоящая БД.
 */
class InMemoryCatalogStore {
  readonly branches = new Map<string, BranchRow>();
  readonly rooms = new Map<string, RoomRow>();
  readonly courses = new Map<string, CourseRow>();

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
      _count: { rooms: 0, students: 0, employees: 0 },
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
      ...overrides,
    };
    this.courses.set(course.id, course);

    return course;
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
      );

    matched.sort((a, b) => a.title.localeCompare(b.title));

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findCourseById(id: string): Promise<CourseRow | null> {
    return Promise.resolve(this.courses.get(id) ?? null);
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

  // ─── Вспомогательное ───

  private branchOrThrow(id: string): BranchRow {
    const branch = this.branches.get(id);
    if (!branch) throw new Error('Филиала нет: тест построен неверно');

    return branch;
  }

  /** Счётчики считаются на лету — как `_count` в настоящем запросе. */
  private withCounts(branch: BranchRow): BranchRow {
    const people = this.people.get(branch.id) ?? { students: 0, employees: 0 };
    branch._count = {
      rooms: [...this.rooms.values()].filter((room) => room.branch.id === branch.id).length,
      students: people.students,
      employees: people.employees,
    };

    return branch;
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
    });

    it('студент не ведёт справочники — 403 (ТЗ 3.2)', async () => {
      const token = await studentToken();

      await get('/api/v1/branches', token).expect(403);
      await get('/api/v1/rooms', token).expect(403);
      await get('/api/v1/courses', token).expect(403);
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

    it('право на филиалы не открывает курсы и аудитории', async () => {
      const token = await actor('Permission.Branches.Views');

      await get('/api/v1/rooms', token).expect(403);
      await get('/api/v1/courses', token).expect(403);
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

    it('удаляет курс; 404 на неизвестный', async () => {
      const token = await actor('Permission.Courses.Delete');
      const course = store.addCourse('Temp');

      const response = await send('delete', `/api/v1/courses/${course.id}`, token).expect(200);
      expect(response.body.data).toEqual({ id: course.id, title: 'Temp' });

      await send('delete', `/api/v1/courses/${randomUUID()}`, token).expect(404);
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
        ]),
      );

      for (const path of ['/api/v1/branches', '/api/v1/rooms', '/api/v1/courses']) {
        expect(Object.keys(document.paths[path]?.post?.responses ?? {})).toContain('201');
      }
    });
  });
});
