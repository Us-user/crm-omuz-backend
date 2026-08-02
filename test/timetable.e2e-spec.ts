import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  AccountType,
  GroupFormat,
  GroupStatus,
  LessonType,
  WeekDay,
  type GroupMentorRole,
} from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { GroupScheduleModule } from 'src/group-schedule/group-schedule.module';
import type {
  OverlapParams,
  ScheduleSlotListParams,
  ScheduleSlotRow,
  ScheduleSlotUpdateInput,
  ScheduleSlotWriteInput,
  SlotConflictRow,
  SlotGroup,
} from 'src/group-schedule/group-schedule.repository';
import { GroupScheduleRepository } from 'src/group-schedule/group-schedule.repository';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { PhoneModule } from 'src/phone/phone.module';
import { RbacModule } from 'src/rbac/rbac.module';
import { RbacRepository } from 'src/rbac/rbac.repository';
import { buildOpenApiDocument } from 'src/swagger';
import { TimetableModule } from 'src/timetable/timetable.module';
import type {
  TimetableJournalParams,
  TimetableJournalRow,
  TimetableSlotParams,
  TimetableSlotRow,
} from 'src/timetable/timetable.repository';
import { TimetableRepository } from 'src/timetable/timetable.repository';

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

interface StoredGroup {
  id: string;
  name: string;
  format: GroupFormat;
  status: GroupStatus;
  startDate: Date | null;
  endDate: Date | null;
  branchId: string;
  branchName: string;
  courseId: string;
  courseTitle: string;
}

interface StoredRoom {
  id: string;
  name: string;
  branchId: string;
}

interface StoredEmployee {
  id: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
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

interface StoredJournalDay {
  groupId: string;
  date: Date;
  type: LessonType;
}

const utc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

/**
 * Группы, аудитории, менторы, слоты и дни журнала **вместе** — одно хранилище
 * подставляется сразу на `GroupScheduleRepository` и `TimetableRepository`.
 *
 * Иначе главное свойство сессии проверить нечем: слот пишет расписание группы,
 * а разворачивает его в даты календарь, и два разведённых хранилища проверяли бы
 * каждое своё, а не то, что связывает их между собой.
 *
 * Отбор календаря здесь **повторяет правила репозитория** (группа не отменена,
 * её сроки пересекают окно, доменные фильтры, сужение по дням недели), а не
 * подставляет готовые строки: иначе тест сравнивал бы две реализации, а не правило.
 *
 * Дни журнала кладутся в хранилище напрямую: `GroupJournalModule` здесь
 * не поднимается — у него четырнадцать методов репозитория, из которых календарю
 * нужен один. Что тип и «проведено» приходят именно из дня журнала, проверяют
 * юнит-тесты `expandTimetable` и случаи ниже.
 */
class InMemoryStore {
  readonly groups = new Map<string, StoredGroup>();
  readonly rooms = new Map<string, StoredRoom>();
  readonly employees = new Map<string, StoredEmployee>();
  readonly groupMentors = new Map<string, Map<string, GroupMentorRole>>();
  readonly slots: StoredSlot[] = [];
  readonly journalDays: StoredJournalDay[] = [];

  seedGroup(overrides: Partial<StoredGroup> = {}): StoredGroup {
    const group: StoredGroup = {
      id: randomUUID(),
      name: 'Frontend-1',
      format: GroupFormat.OFFLINE,
      status: GroupStatus.ACTIVE,
      startDate: null,
      endDate: null,
      branchId: BRANCH_ID,
      branchName: 'Садбарг',
      courseId: COURSE_ID,
      courseTitle: 'Frontend',
      ...overrides,
    };
    this.groups.set(group.id, group);

    return group;
  }

  seedRoom(name = '101', branchId = BRANCH_ID): StoredRoom {
    const room: StoredRoom = { id: randomUUID(), name, branchId };
    this.rooms.set(room.id, room);

    return room;
  }

  seedMentor(groupId: string, lastName = 'Раҳимов'): StoredEmployee {
    const employee: StoredEmployee = {
      id: randomUUID(),
      firstName: 'Фаррух',
      lastName,
      middleName: null,
    };
    this.employees.set(employee.id, employee);

    const mentors = this.groupMentors.get(groupId) ?? new Map<string, GroupMentorRole>();
    mentors.set(employee.id, 'TEACHING');
    this.groupMentors.set(groupId, mentors);

    return employee;
  }

  seedJournalDay(groupId: string, date: string, type: LessonType): void {
    this.journalDays.push({ groupId, date: utc(date), type });
  }

  // ─── GroupScheduleRepository ───

  findMany(params: ScheduleSlotListParams): Promise<{ rows: ScheduleSlotRow[]; total: number }> {
    const rows = this.slots
      .filter((slot) => slot.groupId === params.groupId)
      .map((slot) => this.toSlotRow(slot));

    return Promise.resolve({
      rows: rows.slice(params.skip, params.skip + params.take),
      total: rows.length,
    });
  }

  findGroup(id: string): Promise<SlotGroup | null> {
    const group = this.groups.get(id);

    return Promise.resolve(
      group === undefined
        ? null
        : {
            id: group.id,
            name: group.name,
            branchId: group.branchId,
            status: group.status,
            startDate: group.startDate,
            endDate: group.endDate,
          },
    );
  }

  findRoom(id: string): Promise<{ id: string; name: string; branchId: string } | null> {
    return Promise.resolve(this.rooms.get(id) ?? null);
  }

  findGroupMentor(
    groupId: string,
    employeeId: string,
  ): Promise<{ employee: { id: string; firstName: string; lastName: string } } | null> {
    const assigned = this.groupMentors.get(groupId)?.has(employeeId) ?? false;
    const employee = this.employees.get(employeeId);

    return Promise.resolve(
      !assigned || employee === undefined
        ? null
        : {
            employee: {
              id: employee.id,
              firstName: employee.firstName,
              lastName: employee.lastName,
            },
          },
    );
  }

  findOne(groupId: string, slotId: string): Promise<ScheduleSlotRow | null> {
    const slot = this.slots.find((row) => row.id === slotId && row.groupId === groupId);

    return Promise.resolve(slot === undefined ? null : this.toSlotRow(slot));
  }

  findOverlapping(params: OverlapParams): Promise<SlotConflictRow[]> {
    const matched = this.slots.filter((slot) => {
      if (params.exceptSlotId !== undefined && slot.id === params.exceptSlotId) return false;
      if (slot.dayOfWeek !== params.dayOfWeek) return false;
      if (slot.startMinute >= params.endMinute || slot.endMinute <= params.startMinute) {
        return false;
      }

      return (
        slot.groupId === params.groupId ||
        (params.roomId !== undefined && slot.roomId === params.roomId) ||
        (params.mentorId !== undefined && slot.mentorId === params.mentorId)
      );
    });

    return Promise.resolve(
      matched.flatMap((slot): SlotConflictRow[] => {
        const group = this.groups.get(slot.groupId);
        if (group === undefined) return [];

        return [
          {
            id: slot.id,
            groupId: slot.groupId,
            dayOfWeek: slot.dayOfWeek,
            startMinute: slot.startMinute,
            endMinute: slot.endMinute,
            roomId: slot.roomId,
            mentorId: slot.mentorId,
            group: {
              id: group.id,
              name: group.name,
              branchId: group.branchId,
              status: group.status,
              startDate: group.startDate,
              endDate: group.endDate,
            },
          },
        ];
      }),
    );
  }

  create(input: ScheduleSlotWriteInput): Promise<ScheduleSlotRow> {
    const slot: StoredSlot = { id: randomUUID(), createdAt: new Date(), ...input };
    this.slots.push(slot);

    return Promise.resolve(this.toSlotRow(slot));
  }

  update(id: string, input: ScheduleSlotUpdateInput): Promise<ScheduleSlotRow> {
    const slot = this.slots.find((row) => row.id === id);
    if (slot === undefined) throw new Error(`Слот ${id} не найден`);

    Object.assign(slot, definedOnly(input));

    return Promise.resolve(this.toSlotRow(slot));
  }

  delete(id: string): Promise<void> {
    const index = this.slots.findIndex((row) => row.id === id);
    if (index >= 0) this.slots.splice(index, 1);

    return Promise.resolve();
  }

  // ─── TimetableRepository (повторяет `where` репозитория) ───

  findSlots(params: TimetableSlotParams): Promise<TimetableSlotRow[]> {
    return Promise.resolve(
      this.slots.flatMap((slot): TimetableSlotRow[] => {
        const group = this.groups.get(slot.groupId);
        if (group === undefined) return [];

        // Отменённая группа занятий не проводила вообще.
        if (group.status === GroupStatus.CANCELLED) return [];
        // Сроки группы пересекают окно (незаполненная граница — открытая).
        if (group.startDate !== null && group.startDate > params.to) return [];
        if (group.endDate !== null && group.endDate < params.from) return [];

        if (params.weekDays !== undefined && !params.weekDays.includes(slot.dayOfWeek)) return [];
        if (params.groupId !== undefined && slot.groupId !== params.groupId) return [];
        if (params.roomId !== undefined && slot.roomId !== params.roomId) return [];
        if (params.mentorId !== undefined && slot.mentorId !== params.mentorId) return [];
        if (params.courseId !== undefined && group.courseId !== params.courseId) return [];
        if (params.branchId !== undefined && group.branchId !== params.branchId) return [];
        if (params.format !== undefined && group.format !== params.format) return [];

        const room = slot.roomId === null ? null : (this.rooms.get(slot.roomId) ?? null);
        const mentor = slot.mentorId === null ? null : (this.employees.get(slot.mentorId) ?? null);

        return [
          {
            id: slot.id,
            dayOfWeek: slot.dayOfWeek,
            startMinute: slot.startMinute,
            endMinute: slot.endMinute,
            group: {
              id: group.id,
              name: group.name,
              format: group.format,
              status: group.status,
              startDate: group.startDate,
              endDate: group.endDate,
              course: { id: group.courseId, title: group.courseTitle },
              branch: { id: group.branchId, name: group.branchName },
            },
            room: room === null ? null : { id: room.id, name: room.name },
            mentor:
              mentor === null
                ? null
                : {
                    id: mentor.id,
                    firstName: mentor.firstName,
                    lastName: mentor.lastName,
                    middleName: mentor.middleName,
                  },
          },
        ];
      }),
    );
  }

  findJournalDays(params: TimetableJournalParams): Promise<TimetableJournalRow[]> {
    return Promise.resolve(
      this.journalDays
        .filter(
          (day) =>
            params.groupIds.includes(day.groupId) &&
            day.date >= params.from &&
            day.date <= params.to,
        )
        .map((day) => ({ date: day.date, type: day.type, week: { groupId: day.groupId } })),
    );
  }

  private toSlotRow(slot: StoredSlot): ScheduleSlotRow {
    const room = slot.roomId === null ? null : (this.rooms.get(slot.roomId) ?? null);
    const mentor = slot.mentorId === null ? null : (this.employees.get(slot.mentorId) ?? null);

    return {
      id: slot.id,
      groupId: slot.groupId,
      dayOfWeek: slot.dayOfWeek,
      startMinute: slot.startMinute,
      endMinute: slot.endMinute,
      createdAt: slot.createdAt,
      room: room === null ? null : { id: room.id, name: room.name },
      mentor:
        mentor === null
          ? null
          : {
              id: mentor.id,
              firstName: mentor.firstName,
              lastName: mentor.lastName,
              middleName: mentor.middleName,
            },
    };
  }
}

const definedOnly = <T extends object>(input: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;

// Настоящие v4-идентификаторы, а не рукописные: `@IsUUID()` проверяет вариант,
// и «44444444-…» не прошёл бы валидацию фильтра (находка сессии 0024).
const COURSE_ID = randomUUID();
const OTHER_COURSE_ID = randomUUID();
const BRANCH_ID = randomUUID();
const OTHER_BRANCH_ID = randomUUID();

interface LessonBody {
  slotId: string;
  date: string;
  weekDay: WeekDay;
  startTime: string;
  endTime: string;
  group: { id: string; name: string; format: GroupFormat; status: GroupStatus };
  course: { id: string; name: string };
  branch: { id: string; name: string };
  room: { id: string; name: string } | null;
  mentor: { id: string; lastName: string } | null;
  type: LessonType | null;
  held: boolean;
}

interface TimetableBody {
  view: string;
  from: string;
  to: string;
  total: number;
  days: { date: string; weekDay: WeekDay; lessons: LessonBody[] }[];
}

/** Все занятия окна одним списком — так короче писать проверки. */
const lessonsOf = (body: TimetableBody): LessonBody[] => body.days.flatMap((day) => day.lessons);

describe('Общее расписание (e2e, хранилище в памяти)', () => {
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
        TimetableModule,
        // Расписание группы поднимается вместе с календарём: именно оно пишет
        // слоты, которые календарь потом разворачивает в даты.
        GroupScheduleModule,
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
      .overrideProvider(TimetableRepository)
      .useValue(store)
      .overrideProvider(GroupScheduleRepository)
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

  const viewer = () => actor(['Permission.Timetable.Views']);
  const operator = () => actor(['Permission.Timetable.Views', 'Permission.Groups.ManageSchedule']);

  const studentToken = async (): Promise<string> =>
    (await tokens.issuePair({ sub: randomUUID(), sid: randomUUID(), type: AccountType.STUDENT }))
      .accessToken;

  const get = (url: string, token: string) =>
    request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);

  /** Постановка занятия настоящим маршрутом расписания группы (ТЗ 5.5). */
  const schedule = (token: string, groupId: string, body: Record<string, unknown>): request.Test =>
    request(app.getHttpServer())
      .post(`/api/v1/groups/${groupId}/schedule`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const calendar = async (token: string, query: string): Promise<TimetableBody> =>
    dataOf<TimetableBody>(await get(`/api/v1/timetable?${query}`, token).expect(200));

  describe('Доступ', () => {
    it('без токена — 401', async () => {
      await request(app.getHttpServer()).get('/api/v1/timetable').expect(401);
    });

    it('студенту календарь закрыт — у него свой /me/schedule', async () => {
      await get('/api/v1/timetable', await studentToken()).expect(403);
    });

    it('сотрудник без прав — 403', async () => {
      await get('/api/v1/timetable', await actor([])).expect(403);
    });

    it('право вести расписание группы календарь не открывает', async () => {
      const token = await actor(['Permission.Groups.ManageSchedule', 'Permission.Groups.Views']);

      await get('/api/v1/timetable', token).expect(403);
    });

    it('право на просмотр расписания открывает календарь', async () => {
      await get('/api/v1/timetable', await viewer()).expect(200);
    });
  });

  describe('Разворот слотов в даты (ТЗ 5.10)', () => {
    it('занятие, поставленное расписанием группы, появляется в календаре', async () => {
      const token = await operator();
      const group = store.seedGroup({ startDate: utc('2026-09-01'), endDate: utc('2026-09-30') });
      const room = store.seedRoom('204');
      const mentor = store.seedMentor(group.id, 'Каримова');

      await schedule(token, group.id, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
        roomId: room.id,
        mentorId: mentor.id,
      }).expect(201);

      const body = await calendar(token, 'view=week&date=2026-09-16');

      expect(body.total).toBe(1);
      const lesson = lessonsOf(body)[0];
      expect(lesson?.date).toBe('2026-09-14');
      expect(lesson?.startTime).toBe('10:00');
      expect(lesson?.endTime).toBe('12:00');
      expect(lesson?.group.name).toBe('Frontend-1');
      expect(lesson?.course.name).toBe('Frontend');
      expect(lesson?.branch.name).toBe('Садбарг');
      expect(lesson?.room?.name).toBe('204');
      expect(lesson?.mentor?.lastName).toBe('Каримова');
    });

    it('еженедельный слот повторяется в каждой неделе месяца', async () => {
      const token = await operator();
      const group = store.seedGroup({ startDate: utc('2026-09-01'), endDate: utc('2026-09-30') });

      await schedule(token, group.id, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
      }).expect(201);

      const body = await calendar(token, 'view=month&date=2026-09-16');

      // Понедельники сентября 2026: 7, 14, 21, 28.
      expect(body.total).toBe(4);
      expect(lessonsOf(body).map((lesson) => lesson.date)).toEqual([
        '2026-09-07',
        '2026-09-14',
        '2026-09-21',
        '2026-09-28',
      ]);
    });

    it('окно day — одна дата', async () => {
      const token = await operator();
      const group = store.seedGroup();

      await schedule(token, group.id, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
      }).expect(201);

      const monday = await calendar(token, 'view=day&date=2026-09-14');
      const tuesday = await calendar(token, 'view=day&date=2026-09-15');

      expect([monday.from, monday.to]).toEqual(['2026-09-14', '2026-09-14']);
      expect(monday.days).toHaveLength(1);
      expect(monday.total).toBe(1);
      expect(tuesday.total).toBe(0);
    });

    it('окно week идёт с понедельника по воскресенье', async () => {
      const body = await calendar(await viewer(), 'view=week&date=2026-09-16');

      expect([body.from, body.to]).toEqual(['2026-09-14', '2026-09-20']);
      expect(body.days.map((day) => day.date)).toEqual([
        '2026-09-14',
        '2026-09-15',
        '2026-09-16',
        '2026-09-17',
        '2026-09-18',
        '2026-09-19',
        '2026-09-20',
      ]);
    });

    it('дни без занятий остаются в ряду с пустым списком', async () => {
      const token = await operator();
      const group = store.seedGroup();

      await schedule(token, group.id, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
      }).expect(201);

      const body = await calendar(token, 'view=week&date=2026-09-16');

      expect(body.days).toHaveLength(7);
      expect(body.days.filter((day) => day.lessons.length === 0)).toHaveLength(6);
    });

    it('за пределами сроков группы занятий нет', async () => {
      const token = await operator();
      const group = store.seedGroup({ startDate: utc('2026-09-15'), endDate: utc('2026-09-30') });

      await schedule(token, group.id, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
      }).expect(201);

      const september = await calendar(token, 'view=month&date=2026-09-16');
      const august = await calendar(token, 'view=month&date=2026-08-16');

      // 7 сентября — до начала обучения; остаются 21 и 28.
      expect(september.total).toBe(2);
      expect(august.total).toBe(0);
    });

    it('отменённая группа в календарь не попадает', async () => {
      const token = await operator();
      const group = store.seedGroup();

      await schedule(token, group.id, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
      }).expect(201);

      store.groups.set(group.id, { ...group, status: GroupStatus.CANCELLED });

      expect((await calendar(token, 'view=week&date=2026-09-16')).total).toBe(0);
    });

    it('завершённая группа остаётся в календаре в пределах своих сроков', async () => {
      const token = await operator();
      const group = store.seedGroup({ startDate: utc('2026-09-01'), endDate: utc('2026-09-30') });

      await schedule(token, group.id, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
      }).expect(201);

      store.groups.set(group.id, { ...store.groups.get(group.id)!, status: GroupStatus.FINISHED });

      expect((await calendar(token, 'view=month&date=2026-09-16')).total).toBe(4);
      expect((await calendar(token, 'view=month&date=2026-10-16')).total).toBe(0);
    });

    it('занятие онлайн остаётся в календаре без аудитории и без ведущего', async () => {
      const token = await operator();
      const group = store.seedGroup({ format: GroupFormat.ONLINE });

      await schedule(token, group.id, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '18:30',
        endTime: '20:00',
      }).expect(201);

      const lesson = lessonsOf(await calendar(token, 'view=day&date=2026-09-14'))[0];

      expect(lesson?.room).toBeNull();
      expect(lesson?.mentor).toBeNull();
      expect(lesson?.startTime).toBe('18:30');
      expect(lesson?.group.format).toBe(GroupFormat.ONLINE);
    });

    it('внутри дня занятия идут по времени начала', async () => {
      const token = await operator();
      const first = store.seedGroup({ name: 'Python-1' });
      const second = store.seedGroup({ name: 'Backend-1' });

      await schedule(token, first.id, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '14:00',
        endTime: '16:00',
      }).expect(201);
      await schedule(token, second.id, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '08:00',
        endTime: '10:00',
      }).expect(201);

      const lessons = lessonsOf(await calendar(token, 'view=day&date=2026-09-14'));

      expect(lessons.map((lesson) => lesson.startTime)).toEqual(['08:00', '14:00']);
    });
  });

  describe('Type и «проведено» из журнала', () => {
    it('день журнала даёт тип занятия и помечает его проведённым', async () => {
      const token = await operator();
      const group = store.seedGroup({ startDate: utc('2026-09-01'), endDate: utc('2026-09-30') });

      await schedule(token, group.id, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
      }).expect(201);

      store.seedJournalDay(group.id, '2026-09-14', LessonType.EXAM);

      const lessons = lessonsOf(await calendar(token, 'view=month&date=2026-09-16'));
      const held = lessons.filter((lesson) => lesson.held);

      expect(held).toHaveLength(1);
      expect(held[0]?.date).toBe('2026-09-14');
      expect(held[0]?.type).toBe(LessonType.EXAM);
    });

    it('без дня журнала занятие остаётся запланированным', async () => {
      const token = await operator();
      const group = store.seedGroup();

      await schedule(token, group.id, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
      }).expect(201);

      const lesson = lessonsOf(await calendar(token, 'view=day&date=2026-09-14'))[0];

      expect(lesson?.type).toBeNull();
      expect(lesson?.held).toBe(false);
    });

    it('день журнала соседней группы чужое занятие не помечает', async () => {
      const token = await operator();
      const mine = store.seedGroup({ name: 'Frontend-1' });
      const other = store.seedGroup({ name: 'Python-1' });

      await schedule(token, mine.id, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
      }).expect(201);

      store.seedJournalDay(other.id, '2026-09-14', LessonType.PRACTICE);

      const lesson = lessonsOf(await calendar(token, 'view=day&date=2026-09-14'))[0];

      expect(lesson?.held).toBe(false);
    });
  });

  describe('Фильтры', () => {
    const seedTwoGroups = async (token: string): Promise<[StoredGroup, StoredGroup]> => {
      const first = store.seedGroup({ name: 'Frontend-1' });
      const second = store.seedGroup({
        name: 'Python-1',
        courseId: OTHER_COURSE_ID,
        courseTitle: 'Python',
        branchId: OTHER_BRANCH_ID,
        branchName: 'Профсоюз',
        format: GroupFormat.ONLINE,
      });

      for (const group of [first, second]) {
        await schedule(token, group.id, {
          dayOfWeek: WeekDay.MONDAY,
          startTime: '10:00',
          endTime: '12:00',
        }).expect(201);
      }

      return [first, second];
    };

    it('по группе', async () => {
      const token = await operator();
      const [first] = await seedTwoGroups(token);

      const body = await calendar(token, `view=day&date=2026-09-14&groupId=${first.id}`);

      expect(body.total).toBe(1);
      expect(lessonsOf(body)[0]?.group.id).toBe(first.id);
    });

    it('по курсу и по филиалу', async () => {
      const token = await operator();
      await seedTwoGroups(token);

      const byCourse = await calendar(token, `view=day&date=2026-09-14&courseId=${COURSE_ID}`);
      const byBranch = await calendar(
        token,
        `view=day&date=2026-09-14&branchId=${OTHER_BRANCH_ID}`,
      );

      expect(byCourse.total).toBe(1);
      expect(lessonsOf(byCourse)[0]?.group.name).toBe('Frontend-1');
      expect(byBranch.total).toBe(1);
      expect(lessonsOf(byBranch)[0]?.group.name).toBe('Python-1');
    });

    it('по формату', async () => {
      const token = await operator();
      await seedTwoGroups(token);

      const online = await calendar(token, 'view=day&date=2026-09-14&format=ONLINE');

      expect(online.total).toBe(1);
      expect(lessonsOf(online)[0]?.group.format).toBe(GroupFormat.ONLINE);
    });

    it('по аудитории и по ведущему', async () => {
      const token = await operator();
      const group = store.seedGroup();
      const room = store.seedRoom('305');
      const mentor = store.seedMentor(group.id);

      await schedule(token, group.id, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
        roomId: room.id,
        mentorId: mentor.id,
      }).expect(201);
      await schedule(token, group.id, {
        dayOfWeek: WeekDay.MONDAY,
        startTime: '14:00',
        endTime: '16:00',
      }).expect(201);

      const byRoom = await calendar(token, `view=day&date=2026-09-14&roomId=${room.id}`);
      const byMentor = await calendar(token, `view=day&date=2026-09-14&mentorId=${mentor.id}`);

      expect(byRoom.total).toBe(1);
      expect(byRoom.days[0]?.lessons[0]?.room?.name).toBe('305');
      // Занятие без назначенного ведущего под фильтр по ментору не попадает.
      expect(byMentor.total).toBe(1);
    });

    it('неизвестная группа в фильтре даёт пустой календарь, а не отказ', async () => {
      const body = await calendar(
        await viewer(),
        `view=day&date=2026-09-14&groupId=${randomUUID()}`,
      );

      expect(body.total).toBe(0);
      expect(body.days).toHaveLength(1);
    });
  });

  describe('Отказы', () => {
    it('несуществующая дата — 400', async () => {
      await get('/api/v1/timetable?date=2026-02-30', await viewer()).expect(400);
    });

    it('дата не в формате YYYY-MM-DD — 400', async () => {
      await get('/api/v1/timetable?date=14.09.2026', await viewer()).expect(400);
    });

    it('неизвестный вид окна — 400', async () => {
      await get('/api/v1/timetable?view=quarter', await viewer()).expect(400);
    });

    it('не-UUID в фильтре — 400', async () => {
      await get('/api/v1/timetable?groupId=frontend', await viewer()).expect(400);
    });

    it('лишнее поле — 400 (пагинации у календаря нет)', async () => {
      await get('/api/v1/timetable?page=2', await viewer()).expect(400);
    });
  });

  describe('OpenAPI', () => {
    it('путь описан и только на чтение', () => {
      const document = buildOpenApiDocument(app);
      const path = document.paths['/api/v1/timetable'];

      expect(path).toBeDefined();
      expect(Object.keys(path ?? {})).toEqual(['get']);
    });
  });
});
