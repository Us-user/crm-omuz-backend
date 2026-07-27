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
  WeekDay,
} from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { GroupScheduleModule } from 'src/group-schedule/group-schedule.module';
import { GroupScheduleRepository } from 'src/group-schedule/group-schedule.repository';
import type {
  OverlapParams,
  ScheduleSlotListParams,
  ScheduleSlotRow,
  ScheduleSlotUpdateInput,
  ScheduleSlotWriteInput,
  SlotConflictRow,
  SlotGroup,
} from 'src/group-schedule/group-schedule.repository';
import { GraduatesRepository } from 'src/graduates/graduates.repository';
import { GroupsModule } from 'src/groups/groups.module';
import type { GroupRow } from 'src/groups/groups.repository';
import { GroupsRepository } from 'src/groups/groups.repository';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { PhoneModule } from 'src/phone/phone.module';
import { RbacModule } from 'src/rbac/rbac.module';
import { RbacRepository } from 'src/rbac/rbac.repository';
import { RoomsModule } from 'src/rooms/rooms.module';
import type { RoomRow } from 'src/rooms/rooms.repository';
import { RoomsRepository } from 'src/rooms/rooms.repository';
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

interface StoredRoom {
  id: string;
  name: string;
  branchId: string;
}

interface StoredSlot {
  id: string;
  groupId: string;
  dayOfWeek: WeekDay;
  startMinute: number;
  endMinute: number;
  roomId: string | null;
  mentorId: string | null;
  createdAt: Date;
}

type StoredMentor = { id: string; firstName: string; lastName: string; middleName: string | null };

/**
 * Расписание в памяти. Группы, аудитории, менторы и слоты держатся вместе,
 * потому что связаны правилами модуля: аудитория проверяется по филиалу группы,
 * ментор — по составу менторов, а пересечения ищутся среди чужих занятий.
 * Несогласованные заглушки проверяли бы не то поведение, которое даёт БД.
 */
class InMemoryScheduleStore {
  readonly groups = new Map<string, SlotGroup>();
  readonly rooms = new Map<string, StoredRoom>();
  readonly mentors = new Map<string, StoredMentor>();
  /** Ключ — `groupId:employeeId`, как составной ключ `group_mentors`. */
  readonly assignments = new Set<string>();

  private readonly slots = new Map<string, StoredSlot>();
  private createdAtCounter = 0;

  addGroup(overrides: Partial<SlotGroup> = {}): SlotGroup {
    const group: SlotGroup = {
      id: randomUUID(),
      name: `Frontend-${String(this.groups.size + 1)}`,
      branchId: 'branch-1',
      status: GroupStatus.ACTIVE,
      startDate: new Date('2026-09-01T00:00:00.000Z'),
      endDate: new Date('2026-09-30T00:00:00.000Z'),
      ...overrides,
    };
    this.groups.set(group.id, group);

    return group;
  }

  addRoom(overrides: Partial<StoredRoom> = {}): StoredRoom {
    const room: StoredRoom = {
      id: randomUUID(),
      name: `10${String(this.rooms.size + 1)}`,
      branchId: 'branch-1',
      ...overrides,
    };
    this.rooms.set(room.id, room);

    return room;
  }

  /** Сотрудник, назначенный ментором перечисленных групп. */
  addMentor(groupIds: string[], overrides: Partial<StoredMentor> = {}): StoredMentor {
    const mentor: StoredMentor = {
      id: randomUUID(),
      firstName: 'Фаррух',
      lastName: `Раҳимов-${String(this.mentors.size + 1)}`,
      middleName: null,
      ...overrides,
    };
    this.mentors.set(mentor.id, mentor);
    for (const groupId of groupIds) this.assignments.add(`${groupId}:${mentor.id}`);

    return mentor;
  }

  /** Сотрудник, который менторов группы не входит: для проверки 422. */
  addOutsider(): StoredMentor {
    return this.addMentor([]);
  }

  // ─── GroupScheduleRepository ───

  findMany(params: ScheduleSlotListParams): Promise<{ rows: ScheduleSlotRow[]; total: number }> {
    const search = params.search?.toLowerCase();
    const matched = [...this.slots.values()]
      .filter((slot) => slot.groupId === params.groupId)
      .filter((slot) => params.dayOfWeek === undefined || slot.dayOfWeek === params.dayOfWeek)
      .filter((slot) => params.roomId === undefined || slot.roomId === params.roomId)
      .filter((slot) => params.mentorId === undefined || slot.mentorId === params.mentorId)
      .filter((slot) => {
        if (search === undefined) return true;
        const room = slot.roomId === null ? undefined : this.rooms.get(slot.roomId);
        const mentor = slot.mentorId === null ? undefined : this.mentors.get(slot.mentorId);

        return [room?.name, mentor?.firstName, mentor?.lastName].some((field) =>
          field?.toLowerCase().includes(search),
        );
      });

    const sort: string = params.sort;
    const order: string = params.order;

    matched.sort((a, b) => {
      const asc =
        sort === 'createdAt'
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : sort === 'startTime'
            ? a.startMinute - b.startMinute || dayIndex(a.dayOfWeek) - dayIndex(b.dayOfWeek)
            : dayIndex(a.dayOfWeek) - dayIndex(b.dayOfWeek) || a.startMinute - b.startMinute;

      return order === 'asc' ? asc : -asc;
    });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take).map((slot) => this.toRow(slot)),
      total: matched.length,
    });
  }

  findGroup(id: string): Promise<SlotGroup | null> {
    return Promise.resolve(this.groups.get(id) ?? null);
  }

  findRoom(id: string): Promise<StoredRoom | null> {
    return Promise.resolve(this.rooms.get(id) ?? null);
  }

  findGroupMentor(
    groupId: string,
    employeeId: string,
  ): Promise<{ employee: { id: string; firstName: string; lastName: string } } | null> {
    const mentor = this.mentors.get(employeeId);
    if (!mentor || !this.assignments.has(`${groupId}:${employeeId}`)) return Promise.resolve(null);

    return Promise.resolve({
      employee: { id: mentor.id, firstName: mentor.firstName, lastName: mentor.lastName },
    });
  }

  findOne(groupId: string, slotId: string): Promise<ScheduleSlotRow | null> {
    const slot = this.slots.get(slotId);

    return Promise.resolve(slot && slot.groupId === groupId ? this.toRow(slot) : null);
  }

  findOverlapping(params: OverlapParams): Promise<SlotConflictRow[]> {
    const matched = [...this.slots.values()].filter(
      (slot) =>
        slot.id !== params.exceptSlotId &&
        slot.dayOfWeek === params.dayOfWeek &&
        slot.startMinute < params.endMinute &&
        slot.endMinute > params.startMinute &&
        (slot.groupId === params.groupId ||
          (params.roomId !== undefined && slot.roomId === params.roomId) ||
          (params.mentorId !== undefined && slot.mentorId === params.mentorId)),
    );

    return Promise.resolve(
      matched.map((slot) => {
        const group = this.groups.get(slot.groupId);
        if (!group) throw new Error('Группы нет: тест построен неверно');

        return {
          id: slot.id,
          groupId: slot.groupId,
          dayOfWeek: slot.dayOfWeek,
          startMinute: slot.startMinute,
          endMinute: slot.endMinute,
          roomId: slot.roomId,
          mentorId: slot.mentorId,
          group,
        };
      }),
    );
  }

  create(input: ScheduleSlotWriteInput): Promise<ScheduleSlotRow> {
    const slot: StoredSlot = {
      id: randomUUID(),
      ...input,
      createdAt: new Date(Date.UTC(2026, 6, 28, 10, this.createdAtCounter++)),
    };
    this.slots.set(slot.id, slot);

    return Promise.resolve(this.toRow(slot));
  }

  update(id: string, input: ScheduleSlotUpdateInput): Promise<ScheduleSlotRow> {
    const slot = this.slots.get(id);
    if (!slot) throw new Error('Слота нет: тест построен неверно');

    // `undefined` означает «колонку не менять» — ровно как в Prisma.
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) Object.assign(slot, { [key]: value });
    }

    return Promise.resolve(this.toRow(slot));
  }

  delete(id: string): Promise<void> {
    this.slots.delete(id);

    return Promise.resolve();
  }

  // ─── То, что нужно соседним модулям для сквозных правил ───

  /** `RoomsRepository.countScheduleSlots` — аудиторию с занятиями не удалить. */
  countRoomSlots(roomId: string): Promise<number> {
    return Promise.resolve([...this.slots.values()].filter((s) => s.roomId === roomId).length);
  }

  /** `GroupsRepository.countScheduleSlotsWithRoom` — перенос группы в другой филиал. */
  countGroupSlotsWithRoom(groupId: string): Promise<number> {
    return Promise.resolve(
      [...this.slots.values()].filter((s) => s.groupId === groupId && s.roomId !== null).length,
    );
  }

  /** `RoomsRepository.findById` — карточка аудитории в том виде, в каком её ждёт сервис. */
  findRoomAsRow(id: string): Promise<RoomRow | null> {
    const room = this.rooms.get(id);
    if (!room) return Promise.resolve(null);

    return Promise.resolve({
      id: room.id,
      name: room.name,
      branch: { id: room.branchId, name: room.branchId },
      capacity: null,
      floor: null,
      description: null,
      status: DirectoryStatus.ACTIVE,
      createdAt: new Date('2026-07-28T09:00:00.000Z'),
    });
  }

  deleteRoom(id: string): Promise<void> {
    this.rooms.delete(id);

    return Promise.resolve();
  }

  /** `GroupsRepository.findById`/`update` — карточка группы для правил переноса. */
  findGroupAsRow(id: string): Promise<GroupRow | null> {
    const group = this.groups.get(id);
    if (!group) return Promise.resolve(null);

    return Promise.resolve({
      id: group.id,
      name: group.name,
      description: null,
      course: { id: 'course-1', title: 'Frontend Basic', isLastCourse: false },
      branch: { id: group.branchId, name: group.branchId },
      format: GroupFormat.OFFLINE,
      startDate: group.startDate,
      endDate: group.endDate,
      durationValue: null,
      durationUnit: DurationUnit.MONTH,
      capacity: null,
      status: group.status,
      telegramUrl: null,
      // Состав здесь не проверяется: этому набору нужны только правила переноса.
      _count: { students: 0 },
      createdAt: new Date('2026-07-28T09:00:00.000Z'),
    });
  }

  private toRow(slot: StoredSlot): ScheduleSlotRow {
    const room = slot.roomId === null ? null : (this.rooms.get(slot.roomId) ?? null);
    const mentor = slot.mentorId === null ? null : (this.mentors.get(slot.mentorId) ?? null);

    return {
      id: slot.id,
      groupId: slot.groupId,
      dayOfWeek: slot.dayOfWeek,
      startMinute: slot.startMinute,
      endMinute: slot.endMinute,
      createdAt: slot.createdAt,
      room: room === null ? null : { id: room.id, name: room.name },
      mentor,
    };
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

/** Порядок дней в PostgreSQL задаёт сам тип — в памяти его приходится повторить. */
const dayIndex = (day: WeekDay): number => WEEK_ORDER.indexOf(day);

interface SlotBody {
  id: string;
  groupId: string;
  dayOfWeek: WeekDay;
  startTime: string;
  endTime: string;
  room: { id: string; name: string } | null;
  mentor: { id: string; firstName: string; lastName: string; middleName: string | null } | null;
  createdAt: string;
}

describe('Расписание группы (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryScheduleStore;
  let rbac: InMemoryRbacRepository;
  let tokens: TokenService;

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
    store = new InMemoryScheduleStore();
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
        GroupScheduleModule,
        // Аудитории и группы — ради двух сквозных правил, которые расписание
        // навязывает соседям (удаление аудитории и перенос группы в другой
        // филиал). Остальное поведение этих модулей проверяет catalog.e2e-spec.
        RoomsModule,
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
      .overrideProvider(GroupScheduleRepository)
      .useValue({
        findMany: (params: ScheduleSlotListParams) => store.findMany(params),
        findGroup: (id: string) => store.findGroup(id),
        findRoom: (id: string) => store.findRoom(id),
        findGroupMentor: (groupId: string, employeeId: string) =>
          store.findGroupMentor(groupId, employeeId),
        findOne: (groupId: string, slotId: string) => store.findOne(groupId, slotId),
        findOverlapping: (params: OverlapParams) => store.findOverlapping(params),
        create: (input: ScheduleSlotWriteInput) => store.create(input),
        update: (id: string, input: ScheduleSlotUpdateInput) => store.update(id, input),
        delete: (id: string) => store.delete(id),
      })
      .overrideProvider(RoomsRepository)
      .useValue({
        findById: (id: string) => store.findRoomAsRow(id),
        countScheduleSlots: (id: string) => store.countRoomSlots(id),
        delete: (id: string) => store.deleteRoom(id),
      })
      .overrideProvider(GroupsRepository)
      .useValue({
        findById: (id: string) => store.findGroupAsRow(id),
        findByName: () => Promise.resolve(null),
        findBranch: (id: string) => Promise.resolve({ id, name: id }),
        countScheduleSlotsWithRoom: (id: string) => store.countGroupSlotsWithRoom(id),
        // Журнала в этом наборе нет: счётчики категорий активности (ТЗ 5.5)
        // проверяет `performance.e2e-spec.ts`, где живут недели и их итоги.
        findActivity: () => Promise.resolve({ members: [], results: [] }),
        update: (id: string) => store.findGroupAsRow(id),
      })
      .overrideProvider(GraduatesRepository)
      .useValue({
        // `GroupsModule` импортирует `GraduatesModule` ради автовыпуска (ТЗ 5.11);
        // здесь выпускать нечего — его проверяет `graduates.e2e-spec.ts`.
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

  /** Группа, соседняя группа, две аудитории и ментор — общая сцена набора. */
  const scene = () => {
    const group = store.addGroup({ name: 'Frontend-1' });
    const otherGroup = store.addGroup({ name: 'Python-1' });
    const room = store.addRoom({ name: '101' });
    const otherRoom = store.addRoom({ name: '102' });
    const mentor = store.addMentor([group.id, otherGroup.id], { lastName: 'Раҳимов' });

    return { group, otherGroup, room, otherRoom, mentor };
  };

  const manager = () => actor('Permission.Groups.ManageSchedule', 'Permission.Groups.Views');

  describe('Доступ', () => {
    it('без токена — 401', async () => {
      const { group } = scene();

      await request(app.getHttpServer()).get(`/api/v1/groups/${group.id}/schedule`).expect(401);
    });

    it('студент расписание группы не ведёт — 403 (ТЗ 3.2)', async () => {
      const { group } = scene();

      await get(`/api/v1/groups/${group.id}/schedule`, await studentToken()).expect(403);
    });

    it('сотрудник без прав — 403', async () => {
      const { group } = scene();

      const response = await get(`/api/v1/groups/${group.id}/schedule`, await actor()).expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('право на просмотр групп открывает расписание, но не правку', async () => {
      const { group } = scene();
      const token = await actor('Permission.Groups.Views');

      await get(`/api/v1/groups/${group.id}/schedule`, token).expect(200);
      await send('post', `/api/v1/groups/${group.id}/schedule`, token, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
      }).expect(403);
    });

    it('право на менторов расписание не открывает — у него своё право', async () => {
      const { group } = scene();

      await send(
        'post',
        `/api/v1/groups/${group.id}/schedule`,
        await actor('Permission.Groups.ManageMentors'),
        { dayOfWeek: WeekDay.MONDAY, startTime: '10:00', endTime: '12:00' },
      ).expect(403);
    });
  });

  describe('Добавление занятия (ТЗ 5.5)', () => {
    it('ставит занятие с аудиторией и ментором, время отдаёт как «HH:MM»', async () => {
      const { group, room, mentor } = scene();

      const response = await send('post', `/api/v1/groups/${group.id}/schedule`, await manager(), {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
        roomId: room.id,
        mentorId: mentor.id,
      }).expect(201);

      expect(dataOf<SlotBody>(response)).toMatchObject({
        groupId: group.id,
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
        room: { id: room.id, name: '101' },
        mentor: { id: mentor.id, lastName: 'Раҳимов' },
      });
    });

    it('занятие онлайн — без аудитории и ментора', async () => {
      const { group } = scene();

      const response = await send('post', `/api/v1/groups/${group.id}/schedule`, await manager(), {
        dayOfWeek: WeekDay.SATURDAY,
        startTime: '18:30',
        endTime: '20:00',
      }).expect(201);

      expect(dataOf<SlotBody>(response)).toMatchObject({
        startTime: '18:30',
        endTime: '20:00',
        room: null,
        mentor: null,
      });
    });

    it('аудитория другого филиала — 422, занятие не создаётся', async () => {
      const { group } = scene();
      const alien = store.addRoom({ name: '201', branchId: 'branch-2' });
      const token = await manager();

      const response = await send('post', `/api/v1/groups/${group.id}/schedule`, token, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
        roomId: alien.id,
      }).expect(422);

      expect(response.body.error.message).toMatch(/другом филиале/);
      const list = await get(`/api/v1/groups/${group.id}/schedule`, token).expect(200);
      expect(list.body.meta.total).toBe(0);
    });

    it('несуществующая аудитория — 422', async () => {
      const { group } = scene();

      await send('post', `/api/v1/groups/${group.id}/schedule`, await manager(), {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
        roomId: randomUUID(),
      }).expect(422);
    });

    it('сотрудник не из менторов группы — 422', async () => {
      const { group } = scene();
      const outsider = store.addOutsider();

      const response = await send('post', `/api/v1/groups/${group.id}/schedule`, await manager(), {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
        mentorId: outsider.id,
      }).expect(422);

      expect(response.body.error.message).toMatch(/не назначен ментором/);
    });

    it('неизвестная группа — 404', async () => {
      await send('post', `/api/v1/groups/${randomUUID()}/schedule`, await manager(), {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
      }).expect(404);
    });

    it.each([
      ['окончание раньше начала', { startTime: '12:00', endTime: '10:00' }],
      ['нулевая длина', { startTime: '10:00', endTime: '10:00' }],
    ])('%s — 400', async (_case, times) => {
      const { group } = scene();

      await send('post', `/api/v1/groups/${group.id}/schedule`, await manager(), {
        dayOfWeek: WeekDay.MONDAY,
        ...times,
      }).expect(400);
    });

    it.each(['24:00', '9:00', '10:5', '10.00', 'полдень'])('время «%s» — 400', async (value) => {
      const { group } = scene();

      await send('post', `/api/v1/groups/${group.id}/schedule`, await manager(), {
        dayOfWeek: WeekDay.MONDAY,
        startTime: value,
        endTime: '23:59',
      }).expect(400);
    });

    it('неизвестный день недели и лишнее поле — 400', async () => {
      const { group } = scene();
      const token = await manager();

      await send('post', `/api/v1/groups/${group.id}/schedule`, token, {
        dayOfWeek: 'FUNDAY',
        startTime: '10:00',
        endTime: '12:00',
      }).expect(400);

      await send('post', `/api/v1/groups/${group.id}/schedule`, token, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
        note: 'важное',
      }).expect(400);
    });

    it('не-UUID в пути — 400', async () => {
      await send('post', '/api/v1/groups/not-a-uuid/schedule', await manager(), {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
      }).expect(400);
    });
  });

  describe('Пересечения занятий', () => {
    const slot = (groupId: string, token: string, body: Record<string, unknown>): request.Test =>
      send('post', `/api/v1/groups/${groupId}/schedule`, token, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
        ...body,
      });

    it('у группы не может быть двух занятий в одно время — 409', async () => {
      const { group, room, otherRoom } = scene();
      const token = await manager();

      await slot(group.id, token, { roomId: room.id }).expect(201);
      const response = await slot(group.id, token, {
        startTime: '11:00',
        endTime: '13:00',
        roomId: otherRoom.id,
      }).expect(409);

      expect(response.body.error.message).toMatch(/У группы уже есть занятие/);
    });

    it('одна аудитория в одно время у двух групп — 409 с названием группы', async () => {
      const { group, otherGroup, room } = scene();
      const token = await manager();

      await slot(group.id, token, { roomId: room.id }).expect(201);
      const response = await slot(otherGroup.id, token, {
        startTime: '11:00',
        endTime: '13:00',
        roomId: room.id,
      }).expect(409);

      expect(response.body.error.message).toMatch(/Аудитория занята группой «Frontend-1»/);
    });

    it('один ментор в одно время у двух групп — 409', async () => {
      const { group, otherGroup, room, otherRoom, mentor } = scene();
      const token = await manager();

      await slot(group.id, token, { roomId: room.id, mentorId: mentor.id }).expect(201);
      const response = await slot(otherGroup.id, token, {
        roomId: otherRoom.id,
        mentorId: mentor.id,
      }).expect(409);

      expect(response.body.error.message).toMatch(/Ментор в это время ведёт занятие/);
    });

    it('занятия встык не пересекаются', async () => {
      const { group, otherGroup, room } = scene();
      const token = await manager();

      await slot(group.id, token, { roomId: room.id }).expect(201);
      await slot(otherGroup.id, token, {
        startTime: '12:00',
        endTime: '14:00',
        roomId: room.id,
      }).expect(201);
    });

    it('та же аудитория в другой день недели — не конфликт', async () => {
      const { group, otherGroup, room } = scene();
      const token = await manager();

      await slot(group.id, token, { roomId: room.id }).expect(201);
      await slot(otherGroup.id, token, {
        dayOfWeek: WeekDay.TUESDAY,
        roomId: room.id,
      }).expect(201);
    });

    it('группа, отучившаяся раньше, аудиторию не держит', async () => {
      const { room } = scene();
      const past = store.addGroup({
        name: 'Python-0',
        startDate: new Date('2026-06-01T00:00:00.000Z'),
        endDate: new Date('2026-06-30T00:00:00.000Z'),
      });
      const fresh = store.addGroup({ name: 'Frontend-9' });
      const token = await manager();

      await slot(past.id, token, { roomId: room.id }).expect(201);
      await slot(fresh.id, token, { roomId: room.id }).expect(201);
    });

    it('занятия завершённой группы аудиторию не держат', async () => {
      const { room } = scene();
      const finished = store.addGroup({ name: 'Python-8', status: GroupStatus.FINISHED });
      const fresh = store.addGroup({ name: 'Frontend-8' });
      const token = await manager();

      await slot(finished.id, token, { roomId: room.id }).expect(201);
      await slot(fresh.id, token, { roomId: room.id }).expect(201);
    });
  });

  describe('Расписание группы: список', () => {
    const fill = async (groupId: string, token: string, roomId: string): Promise<void> => {
      await send('post', `/api/v1/groups/${groupId}/schedule`, token, {
        dayOfWeek: WeekDay.WEDNESDAY,
        startTime: '14:00',
        endTime: '16:00',
        roomId,
      }).expect(201);
      await send('post', `/api/v1/groups/${groupId}/schedule`, token, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
        roomId,
      }).expect(201);
    };

    it('по умолчанию идёт с начала недели и отдаёт `{ data, meta }`', async () => {
      const { group, room } = scene();
      const token = await manager();
      await fill(group.id, token, room.id);

      const response = await get(`/api/v1/groups/${group.id}/schedule`, token).expect(200);

      expect(response.body.meta).toMatchObject({ total: 2, page: 1, limit: 20 });
      expect(dataOf<SlotBody[]>(response).map((s) => s.dayOfWeek)).toEqual([
        WeekDay.MONDAY,
        WeekDay.WEDNESDAY,
      ]);
    });

    it('фильтр по дню недели', async () => {
      const { group, room } = scene();
      const token = await manager();
      await fill(group.id, token, room.id);

      const response = await get(
        `/api/v1/groups/${group.id}/schedule?dayOfWeek=WEDNESDAY`,
        token,
      ).expect(200);

      expect(dataOf<SlotBody[]>(response)).toHaveLength(1);
      expect(dataOf<SlotBody[]>(response)[0]?.startTime).toBe('14:00');
    });

    it('занятия соседней группы в расписание не попадают', async () => {
      const { group, otherGroup, room, otherRoom } = scene();
      const token = await manager();
      await fill(group.id, token, room.id);
      await send('post', `/api/v1/groups/${otherGroup.id}/schedule`, token, {
        dayOfWeek: WeekDay.FRIDAY,
        startTime: '09:00',
        endTime: '10:00',
        roomId: otherRoom.id,
      }).expect(201);

      const response = await get(`/api/v1/groups/${group.id}/schedule`, token).expect(200);

      expect(response.body.meta.total).toBe(2);
    });

    it('поиск по названию аудитории и фильтр по ментору', async () => {
      const { group, room, mentor } = scene();
      const token = await manager();
      await send('post', `/api/v1/groups/${group.id}/schedule`, token, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
        roomId: room.id,
        mentorId: mentor.id,
      }).expect(201);
      await send('post', `/api/v1/groups/${group.id}/schedule`, token, {
        dayOfWeek: WeekDay.FRIDAY,
        startTime: '10:00',
        endTime: '12:00',
      }).expect(201);

      const bySearch = await get(`/api/v1/groups/${group.id}/schedule?search=101`, token).expect(
        200,
      );
      expect(bySearch.body.meta.total).toBe(1);

      const byMentor = await get(
        `/api/v1/groups/${group.id}/schedule?mentorId=${mentor.id}`,
        token,
      ).expect(200);
      expect(byMentor.body.meta.total).toBe(1);
    });

    it('неизвестная группа — 404', async () => {
      await get(`/api/v1/groups/${randomUUID()}/schedule`, await manager()).expect(404);
    });
  });

  describe('Правка занятия', () => {
    const createSlot = async (
      groupId: string,
      token: string,
      body: Record<string, unknown> = {},
    ): Promise<SlotBody> =>
      dataOf<SlotBody>(
        await send('post', `/api/v1/groups/${groupId}/schedule`, token, {
          dayOfWeek: WeekDay.MONDAY,
          startTime: '10:00',
          endTime: '12:00',
          ...body,
        }).expect(201),
      );

    it('переносит занятие на другой день, не трогая непереданное', async () => {
      const { group, room } = scene();
      const token = await manager();
      const slot = await createSlot(group.id, token, { roomId: room.id });

      const response = await send('put', `/api/v1/groups/${group.id}/schedule/${slot.id}`, token, {
        dayOfWeek: WeekDay.THURSDAY,
      }).expect(200);

      expect(dataOf<SlotBody>(response)).toMatchObject({
        dayOfWeek: WeekDay.THURSDAY,
        startTime: '10:00',
        endTime: '12:00',
        room: { id: room.id },
      });
    });

    it('пустая строка убирает аудиторию из занятия', async () => {
      const { group, room } = scene();
      const token = await manager();
      const slot = await createSlot(group.id, token, { roomId: room.id });

      const response = await send('put', `/api/v1/groups/${group.id}/schedule/${slot.id}`, token, {
        roomId: '',
      }).expect(200);

      expect(dataOf<SlotBody>(response).room).toBeNull();
    });

    it('пустая строка убирает ментора из занятия', async () => {
      const { group, room, mentor } = scene();
      const token = await manager();
      const slot = await createSlot(group.id, token, { roomId: room.id, mentorId: mentor.id });

      const response = await send('put', `/api/v1/groups/${group.id}/schedule/${slot.id}`, token, {
        mentorId: '',
      }).expect(200);

      expect(dataOf<SlotBody>(response).mentor).toBeNull();
    });

    it('новое окончание сверяется с началом из БД — 400', async () => {
      const { group } = scene();
      const token = await manager();
      const slot = await createSlot(group.id, token);

      await send('put', `/api/v1/groups/${group.id}/schedule/${slot.id}`, token, {
        endTime: '09:00',
      }).expect(400);
    });

    it('сам с собой слот не конфликтует: время меняется в пределах занятого окна', async () => {
      const { group, room } = scene();
      const token = await manager();
      const slot = await createSlot(group.id, token, { roomId: room.id });

      await send('put', `/api/v1/groups/${group.id}/schedule/${slot.id}`, token, {
        startTime: '10:30',
      }).expect(200);
    });

    it('перенос на время, занятое другой группой в той же аудитории, — 409', async () => {
      const { group, otherGroup, room } = scene();
      const token = await manager();
      const slot = await createSlot(group.id, token, {
        dayOfWeek: WeekDay.TUESDAY,
        roomId: room.id,
      });
      await createSlot(otherGroup.id, token, { roomId: room.id });

      await send('put', `/api/v1/groups/${group.id}/schedule/${slot.id}`, token, {
        dayOfWeek: WeekDay.MONDAY,
      }).expect(409);
    });

    it('занятие соседней группы через свою не правится — 404', async () => {
      const { group, otherGroup, otherRoom } = scene();
      const token = await manager();
      const alien = await createSlot(otherGroup.id, token, { roomId: otherRoom.id });

      await send('put', `/api/v1/groups/${group.id}/schedule/${alien.id}`, token, {
        startTime: '11:00',
      }).expect(404);
    });

    it('roomId не-UUID и не пустая строка — 400', async () => {
      const { group } = scene();
      const token = await manager();
      const slot = await createSlot(group.id, token);

      await send('put', `/api/v1/groups/${group.id}/schedule/${slot.id}`, token, {
        roomId: 'комната',
      }).expect(400);
    });
  });

  describe('Удаление занятия', () => {
    it('убирает занятие и называет убранное', async () => {
      const { group, room } = scene();
      const token = await manager();
      const slot = dataOf<SlotBody>(
        await send('post', `/api/v1/groups/${group.id}/schedule`, token, {
          dayOfWeek: WeekDay.MONDAY,
          startTime: '10:00',
          endTime: '12:00',
          roomId: room.id,
        }).expect(201),
      );

      const response = await send(
        'delete',
        `/api/v1/groups/${group.id}/schedule/${slot.id}`,
        token,
      ).expect(200);

      expect(dataOf<Record<string, unknown>>(response)).toEqual({
        id: slot.id,
        groupId: group.id,
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
      });

      const list = await get(`/api/v1/groups/${group.id}/schedule`, token).expect(200);
      expect(list.body.meta.total).toBe(0);
    });

    it('повторное удаление — 404', async () => {
      const { group } = scene();
      const token = await manager();

      await send('delete', `/api/v1/groups/${group.id}/schedule/${randomUUID()}`, token).expect(
        404,
      );
    });
  });

  describe('Сквозные правила соседних модулей', () => {
    it('аудиторию с занятиями удалить нельзя — 409 с их числом', async () => {
      const { group, room } = scene();
      const token = await manager();
      await send('post', `/api/v1/groups/${group.id}/schedule`, token, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
        roomId: room.id,
      }).expect(201);

      const response = await send(
        'delete',
        `/api/v1/rooms/${room.id}`,
        await actor('Permission.Rooms.Delete'),
      ).expect(409);

      expect(response.body.error.message).toMatch(/занятия \(1\)/);
    });

    it('освободившаяся аудитория удаляется', async () => {
      const { group, room } = scene();
      const token = await manager();
      const slot = dataOf<SlotBody>(
        await send('post', `/api/v1/groups/${group.id}/schedule`, token, {
          dayOfWeek: WeekDay.MONDAY,
          startTime: '10:00',
          endTime: '12:00',
          roomId: room.id,
        }).expect(201),
      );
      await send('delete', `/api/v1/groups/${group.id}/schedule/${slot.id}`, token).expect(200);

      await send(
        'delete',
        `/api/v1/rooms/${room.id}`,
        await actor('Permission.Rooms.Delete'),
      ).expect(200);
    });

    it('группу с занятиями в аудиториях в другой филиал не перенести — 422', async () => {
      const { group, room } = scene();
      const token = await manager();
      await send('post', `/api/v1/groups/${group.id}/schedule`, token, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
        roomId: room.id,
      }).expect(201);

      const response = await send(
        'put',
        `/api/v1/groups/${group.id}`,
        await actor('Permission.Groups.Update'),
        { branchId: '00000000-0000-4000-8000-000000000002' },
      ).expect(422);

      expect(response.body.error.message).toMatch(/уберите аудитории/i);
    });

    it('расписание без аудиторий переносу группы не мешает', async () => {
      const { group } = scene();
      const token = await manager();
      await send('post', `/api/v1/groups/${group.id}/schedule`, token, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
      }).expect(201);

      await send('put', `/api/v1/groups/${group.id}`, await actor('Permission.Groups.Update'), {
        branchId: '00000000-0000-4000-8000-000000000002',
      }).expect(200);
    });
  });

  describe('OpenAPI', () => {
    it('документ описывает маршруты расписания и код 201 на добавление', () => {
      // Документ собирается напрямую: маршрут `/docs/json` монтируется только
      // при `SWAGGER_ENABLED=true`, а в CI Swagger выключен (сессия 0006).
      const document = buildOpenApiDocument(app);

      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/groups/{groupId}/schedule',
          '/api/v1/groups/{groupId}/schedule/{slotId}',
        ]),
      );

      expect(
        Object.keys(document.paths['/api/v1/groups/{groupId}/schedule']?.post?.responses ?? {}),
      ).toContain('201');
    });
  });
});
