import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { AttendanceMark, GroupStudentStatus, LessonType } from '@prisma/client';
import { AccountType } from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, SortOrder, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { GroupJournalModule } from 'src/group-journal/group-journal.module';
import type {
  CreateWeekInput,
  JournalGroup,
  JournalListParams,
  RosterRow,
  StudentProfile,
  SubmitWeekInput,
  UpdateWeekInput,
  WeekAggregate,
  WeekDetailRow,
  WeekSummaryRow,
} from 'src/group-journal/group-journal.repository';
import { GroupJournalRepository } from 'src/group-journal/group-journal.repository';
import { JournalWeekSortField } from 'src/group-journal/dto';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
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

interface StoredDay {
  id: string;
  date: Date;
  type: LessonType;
  /** Кто фактически провёл занятие — из него считаются часы зарплаты (ТЗ 5.16). */
  mentorId: string | null;
  durationMinutes: number | null;
}

interface StoredEntry {
  dayId: string;
  studentId: string;
  attendance: AttendanceMark | null;
  score: number | null;
}

interface StoredWeek {
  id: string;
  groupId: string;
  weekNumber: number;
  startDate: Date;
  submittedAt: Date | null;
  submittedById: string | null;
  days: StoredDay[];
  entries: Map<string, StoredEntry>;
  results: Map<string, { bonus: number; exam: number; sum: number }>;
}

interface StoredEmployee {
  id: string;
  accountId: string;
  firstName: string;
  lastName: string;
}

const cellKey = (dayId: string, studentId: string): string => `${dayId}:${studentId}`;

/**
 * Журнал, состав группы и коины вместе. Правила модуля связывают их между собой:
 * итог недели считается по клеткам, коины — по итогу, а строка журнала берёт
 * профиль из состава. Несогласованные заглушки проверяли бы не то поведение,
 * которое даёт БД.
 */
class InMemoryJournalStore {
  readonly groups = new Map<string, JournalGroup>();
  readonly students = new Map<string, StudentProfile>();
  readonly memberships = new Map<string, RosterRow[]>();
  readonly weeks = new Map<string, StoredWeek>();
  readonly employeesByAccount = new Map<string, StoredEmployee>();
  /** Менторы группы: из них выбирается ведущий учебного дня (правило 0011, 0032). */
  readonly groupMentors = new Map<string, Set<string>>();
  /** Начисленные коины: студент → сумма. Проверяется тестами финализации. */
  readonly coins = new Map<string, number>();
  readonly coinReasons: { studentId: string; amount: number; reason: string }[] = [];

  addGroup(name = 'Frontend-1'): string {
    const id = randomUUID();
    this.groups.set(id, { id, name });
    this.memberships.set(id, []);
    this.groupMentors.set(id, new Set());

    return id;
  }

  addStudent(lastName: string, firstName = 'Имя'): string {
    const id = randomUUID();
    this.students.set(id, {
      id,
      firstName,
      lastName,
      phone: `+9929012345${String(this.students.size).padStart(2, '0')}`,
      photoUrl: null,
    });

    return id;
  }

  enroll(groupId: string, studentId: string, status: GroupStudentStatus = 'ACTIVE'): void {
    const student = this.students.get(studentId);
    if (student === undefined) throw new Error('Нет такого студента');

    this.memberships.get(groupId)?.push({ studentId, status, student });
  }

  addEmployee(accountId: string, firstName = 'Фаррух', lastName = 'Раҳимов'): StoredEmployee {
    const employee: StoredEmployee = { id: randomUUID(), accountId, firstName, lastName };
    this.employeesByAccount.set(accountId, employee);

    return employee;
  }

  /** Назначить сотрудника ментором группы — без этого он не может вести день. */
  addGroupMentor(groupId: string, employeeId: string): void {
    const mentors = this.groupMentors.get(groupId) ?? new Set<string>();
    mentors.add(employeeId);
    this.groupMentors.set(groupId, mentors);
  }

  findGroupMentorIds(groupId: string): Promise<Set<string>> {
    return Promise.resolve(new Set(this.groupMentors.get(groupId) ?? []));
  }

  /** Профиль ментора для строки дня — как вложенный `select` в репозитории. */
  private mentorOf(mentorId: string | null): StoredEmployee | null {
    if (mentorId === null) return null;

    return [...this.employeesByAccount.values()].find((item) => item.id === mentorId) ?? null;
  }

  // ─── GroupJournalRepository ───

  findGroup(id: string): Promise<JournalGroup | null> {
    return Promise.resolve(this.groups.get(id) ?? null);
  }

  findWeeks(params: JournalListParams): Promise<{ rows: WeekSummaryRow[]; total: number }> {
    const matched = [...this.weeks.values()]
      .filter((week) => week.groupId === params.groupId)
      .filter(
        (week) =>
          params.submitted === undefined || (week.submittedAt !== null) === params.submitted,
      )
      .sort((a, b) => {
        const asc =
          params.sort === JournalWeekSortField.StartDate
            ? a.startDate.getTime() - b.startDate.getTime()
            : a.weekNumber - b.weekNumber;

        return params.order === SortOrder.Asc ? asc : -asc;
      });

    return Promise.resolve({
      rows: matched
        .slice(params.skip, params.skip + params.take)
        .map((week) => this.toSummary(week)),
      total: matched.length,
    });
  }

  aggregateWeeks(weekIds: string[]): Promise<WeekAggregate[]> {
    return Promise.resolve(
      weekIds
        .map((weekId) => this.weeks.get(weekId))
        .filter((week): week is StoredWeek => week !== undefined && week.results.size > 0)
        .map((week) => {
          const sums = [...week.results.values()].map((result) => result.sum);

          return {
            weekId: week.id,
            studentsCount: sums.length,
            averageSum: sums.reduce((total, sum) => total + sum, 0) / sums.length,
          };
        }),
    );
  }

  findWeek(groupId: string, weekId: string): Promise<WeekDetailRow | null> {
    const week = this.weeks.get(weekId);

    return Promise.resolve(week && week.groupId === groupId ? this.toDetail(week) : null);
  }

  findRoster(groupId: string): Promise<RosterRow[]> {
    const rows = [...(this.memberships.get(groupId) ?? [])].sort((a, b) =>
      a.student.lastName.localeCompare(b.student.lastName, 'ru'),
    );

    return Promise.resolve(rows);
  }

  findStudents(ids: string[]): Promise<StudentProfile[]> {
    return Promise.resolve(
      ids
        .map((id) => this.students.get(id))
        .filter((student): student is StudentProfile => student !== undefined),
    );
  }

  nextWeekNumber(groupId: string): Promise<number> {
    const numbers = [...this.weeks.values()]
      .filter((week) => week.groupId === groupId)
      .map((week) => week.weekNumber);

    return Promise.resolve(Math.max(0, ...numbers) + 1);
  }

  findConflictingDays(
    groupId: string,
    dates: Date[],
    exceptWeekId?: string,
  ): Promise<{ date: Date; week: { weekNumber: number } }[]> {
    const wanted = new Set(dates.map((date) => date.getTime()));

    return Promise.resolve(
      [...this.weeks.values()]
        .filter((week) => week.groupId === groupId && week.id !== exceptWeekId)
        .flatMap((week) =>
          week.days
            .filter((day) => wanted.has(day.date.getTime()))
            .map((day) => ({ date: day.date, week: { weekNumber: week.weekNumber } })),
        ),
    );
  }

  createWeek(input: CreateWeekInput): Promise<WeekDetailRow> {
    const week: StoredWeek = {
      id: randomUUID(),
      groupId: input.groupId,
      weekNumber: input.weekNumber,
      startDate: input.startDate,
      submittedAt: null,
      submittedById: null,
      days: input.days.map((day) => ({
        id: randomUUID(),
        date: day.date,
        type: day.type,
        mentorId: day.mentorId,
        durationMinutes: day.durationMinutes,
      })),
      entries: new Map(),
      results: new Map(
        input.studentIds.map((studentId) => [studentId, { bonus: 0, exam: 0, sum: 0 }]),
      ),
    };
    this.weeks.set(week.id, week);

    return Promise.resolve(this.toDetail(week));
  }

  updateWeek(input: UpdateWeekInput): Promise<WeekDetailRow> {
    const week = this.require(input.weekId);

    if (input.startDate !== undefined) week.startDate = input.startDate;

    if (input.days !== undefined) {
      const wanted = new Map(input.days.map((day) => [day.date.getTime(), day]));

      // Убранный день уносит свои клетки — как каскад в БД.
      for (const day of week.days) {
        if (wanted.has(day.date.getTime())) continue;

        for (const key of [...week.entries.keys()]) {
          if (week.entries.get(key)?.dayId === day.id) week.entries.delete(key);
        }
      }

      week.days = input.days.map((day) => {
        const existing = week.days.find((item) => item.date.getTime() === day.date.getTime());

        // Набор дней заменяется целиком, поэтому ведущий и длительность тоже
        // записываются целиком — ровно то, что делает `upsert` в репозитории.
        return {
          id: existing?.id ?? randomUUID(),
          date: day.date,
          type: day.type,
          mentorId: day.mentorId,
          durationMinutes: day.durationMinutes,
        };
      });
    }

    for (const entry of input.entries ?? []) {
      const day = week.days.find((item) => item.date.getTime() === entry.date.getTime());
      if (day === undefined) continue;

      const key = cellKey(day.id, entry.studentId);
      const current = week.entries.get(key) ?? {
        dayId: day.id,
        studentId: entry.studentId,
        attendance: null,
        score: null,
      };

      week.entries.set(key, {
        ...current,
        attendance: entry.attendance === undefined ? current.attendance : entry.attendance,
        score: entry.score === undefined ? current.score : entry.score,
      });
    }

    for (const result of input.results) {
      week.results.set(result.studentId, {
        bonus: result.bonus,
        exam: result.exam,
        sum: result.sum,
      });
    }

    return Promise.resolve(this.toDetail(week));
  }

  submitWeek(input: SubmitWeekInput): Promise<WeekDetailRow> {
    const week = this.require(input.weekId);

    for (const result of input.results) {
      week.results.set(result.studentId, {
        bonus: result.bonus,
        exam: result.exam,
        sum: result.sum,
      });
    }

    for (const award of input.awards) {
      this.coins.set(award.studentId, (this.coins.get(award.studentId) ?? 0) + award.amount);
      this.coinReasons.push(award);
    }

    week.submittedAt = input.submittedAt;
    week.submittedById = input.submittedById;

    return Promise.resolve(this.toDetail(week));
  }

  deleteWeek(weekId: string): Promise<void> {
    this.weeks.delete(weekId);

    return Promise.resolve();
  }

  findEmployeeByAccount(accountId: string): Promise<{ id: string } | null> {
    const employee = this.employeesByAccount.get(accountId);

    return Promise.resolve(employee ? { id: employee.id } : null);
  }

  private require(weekId: string): StoredWeek {
    const week = this.weeks.get(weekId);
    if (week === undefined) throw new Error('Нет такой недели');

    return week;
  }

  private submitter(week: StoredWeek): { id: string; firstName: string; lastName: string } | null {
    if (week.submittedById === null) return null;

    const employee = [...this.employeesByAccount.values()].find(
      ({ id }) => id === week.submittedById,
    );

    return employee
      ? { id: employee.id, firstName: employee.firstName, lastName: employee.lastName }
      : null;
  }

  private days(week: StoredWeek): StoredDay[] {
    return [...week.days].sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  private toSummary(week: StoredWeek): WeekSummaryRow {
    return {
      id: week.id,
      groupId: week.groupId,
      weekNumber: week.weekNumber,
      startDate: week.startDate,
      submittedAt: week.submittedAt,
      submittedBy: this.submitter(week),
      days: this.days(week).map((day) => ({
        id: day.id,
        date: day.date,
        type: day.type,
        mentor: this.mentorOf(day.mentorId),
        durationMinutes: day.durationMinutes,
      })),
    };
  }

  private toDetail(week: StoredWeek): WeekDetailRow {
    return {
      ...this.toSummary(week),
      days: this.days(week).map((day) => ({
        id: day.id,
        date: day.date,
        type: day.type,
        mentor: this.mentorOf(day.mentorId),
        durationMinutes: day.durationMinutes,
        entries: [...week.entries.values()]
          .filter((entry) => entry.dayId === day.id)
          .map((entry) => ({
            studentId: entry.studentId,
            attendance: entry.attendance,
            score: entry.score,
          })),
      })),
      results: [...week.results].map(([studentId, result]) => ({ studentId, ...result })),
    };
  }
}

interface WeekBody {
  id: string;
  weekNumber: number;
  startDate: string;
  endDate: string | null;
  submitted: boolean;
  studentsCount: number;
  averageSum: number | null;
  days: { id: string; date: string; type: LessonType }[];
  rows: {
    student: { id: string; lastName: string };
    membershipStatus: GroupStudentStatus | null;
    entries: { date: string; attendance: AttendanceMark | null; score: number | null }[];
    attendanceScore: number;
    homeworkScore: number;
    exam: number;
    bonus: number;
    sum: number;
  }[];
}

describe('Журнал группы (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryJournalStore;
  let rbac: InMemoryRbacRepository;
  let tokens: TokenService;

  beforeEach(async () => {
    store = new InMemoryJournalStore();
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
        GroupJournalModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
      ],
    })
      // AuthModule нужен целиком: он приносит глобальный `JwtAuthGuard`.
      .overrideProvider(AuthRepository)
      .useValue({})
      .overrideProvider(RbacRepository)
      .useValue(rbac)
      .overrideProvider(GroupJournalRepository)
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
    store.addEmployee(accountId);

    return (
      await tokens.issuePair({ sub: accountId, sid: randomUUID(), type: AccountType.EMPLOYEE })
    ).accessToken;
  };

  const studentToken = async (): Promise<string> =>
    (await tokens.issuePair({ sub: randomUUID(), sid: randomUUID(), type: AccountType.STUDENT }))
      .accessToken;

  const ALL = [
    'Permission.Journal.Views',
    'Permission.Journal.Update',
    'Permission.Journal.Submit',
  ];

  const get = (url: string, token: string) =>
    request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);

  const post = (url: string, token: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${token}`).send(body);

  const put = (url: string, token: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).put(url).set('Authorization', `Bearer ${token}`).send(body);

  const del = (url: string, token: string) =>
    request(app.getHttpServer()).delete(url).set('Authorization', `Bearer ${token}`);

  const journalUrl = (groupId: string) => `/api/v1/groups/${groupId}/journal`;

  /** Группа с двумя студентами и заведённой неделей из лекции и экзамена. */
  const setup = async (token: string) => {
    const groupId = store.addGroup();
    const nigina = store.addStudent('Каримова', 'Нигина');
    const ali = store.addStudent('Ахмадов', 'Али');
    store.enroll(groupId, nigina);
    store.enroll(groupId, ali);

    const created = await post(`${journalUrl(groupId)}/weeks`, token, {
      startDate: '2026-09-07',
      days: [{ date: '2026-09-07' }, { date: '2026-09-09', type: 'EXAM' }],
    }).expect(201);

    return { groupId, nigina, ali, week: dataOf<WeekBody>(created) };
  };

  describe('Доступ', () => {
    it('без токена — 401', async () => {
      await request(app.getHttpServer()).get(journalUrl(store.addGroup())).expect(401);
    });

    it('студент журнал группы не читает — 403 (ТЗ 3.2)', async () => {
      await get(journalUrl(store.addGroup()), await studentToken()).expect(403);
    });

    it('сотрудник без прав — 403', async () => {
      await get(journalUrl(store.addGroup()), await actor([])).expect(403);
    });

    it('право на просмотр журнала не даёт заводить неделю', async () => {
      const groupId = store.addGroup();
      const token = await actor(['Permission.Journal.Views']);

      await get(journalUrl(groupId), token).expect(200);
      await post(`${journalUrl(groupId)}/weeks`, token, {
        startDate: '2026-09-07',
        days: [{ date: '2026-09-07' }],
      }).expect(403);
    });

    it('право на правку не даёт финализировать', async () => {
      const token = await actor(['Permission.Journal.Views', 'Permission.Journal.Update']);
      const { groupId, week } = await setup(token);

      await post(`${journalUrl(groupId)}/weeks/${week.id}/submit`, token).expect(403);
    });

    it('право на группы журнал не открывает', async () => {
      await get(journalUrl(store.addGroup()), await actor(['Permission.Groups.Views'])).expect(403);
    });
  });

  describe('Новая неделя (ТЗ 5.8: NEW WEEK)', () => {
    it('заводит неделю с днями, номером и нулевыми итогами состава', async () => {
      const token = await actor(ALL);
      const { week } = await setup(token);

      expect(week).toMatchObject({
        weekNumber: 1,
        startDate: '2026-09-07',
        endDate: '2026-09-09',
        submitted: false,
        studentsCount: 2,
        averageSum: 0,
      });
      expect(week.days.map((day) => `${day.date}:${day.type}`)).toEqual([
        '2026-09-07:LECTURE',
        '2026-09-09:EXAM',
      ]);
      expect(week.rows.map((row) => row.student.lastName)).toEqual(['Ахмадов', 'Каримова']);
    });

    it('номер недели растёт сам', async () => {
      const token = await actor(ALL);
      const { groupId } = await setup(token);

      const second = await post(`${journalUrl(groupId)}/weeks`, token, {
        startDate: '2026-09-14',
        days: [{ date: '2026-09-14' }],
      }).expect(201);

      expect(dataOf<WeekBody>(second).weekNumber).toBe(2);
    });

    it('400 на день за пределами недели и на повтор даты', async () => {
      const token = await actor(ALL);
      const groupId = store.addGroup();

      await post(`${journalUrl(groupId)}/weeks`, token, {
        startDate: '2026-09-07',
        days: [{ date: '2026-09-14' }],
      }).expect(400);

      await post(`${journalUrl(groupId)}/weeks`, token, {
        startDate: '2026-09-07',
        days: [{ date: '2026-09-07' }, { date: '2026-09-07' }],
      }).expect(400);
    });

    it('400 на пустой список дней, восьмой день, лишнее поле и 30 февраля', async () => {
      const token = await actor(ALL);
      const groupId = store.addGroup();
      const url = `${journalUrl(groupId)}/weeks`;

      await post(url, token, { startDate: '2026-09-07', days: [] }).expect(400);
      await post(url, token, {
        startDate: '2026-09-07',
        days: Array.from({ length: 8 }, (_, index) => ({
          date: `2026-09-${String(7 + index).padStart(2, '0')}`,
        })),
      }).expect(400);
      await post(url, token, {
        startDate: '2026-09-07',
        days: [{ date: '2026-09-07' }],
        weekNumber: 7,
      }).expect(400);
      await post(url, token, {
        startDate: '2026-02-30',
        days: [{ date: '2026-02-30' }],
      }).expect(400);
    });

    it('409 на день, уже занятый другой неделей группы', async () => {
      const token = await actor(ALL);
      const { groupId } = await setup(token);

      // Понедельник уже входит в первую неделю: приход за него посчитался бы дважды.
      await post(`${journalUrl(groupId)}/weeks`, token, {
        startDate: '2026-09-07',
        days: [{ date: '2026-09-07' }],
      }).expect(409);
    });

    it('тот же день в другой группе — не конфликт', async () => {
      const token = await actor(ALL);
      await setup(token);
      const other = store.addGroup('Python-1');

      await post(`${journalUrl(other)}/weeks`, token, {
        startDate: '2026-09-07',
        days: [{ date: '2026-09-07' }],
      }).expect(201);
    });

    it('404 на неизвестную группу и 400 на не-UUID в пути', async () => {
      const token = await actor(ALL);

      await post(`${journalUrl(randomUUID())}/weeks`, token, {
        startDate: '2026-09-07',
        days: [{ date: '2026-09-07' }],
      }).expect(404);
      await post(`${journalUrl('не-uuid')}/weeks`, token, {
        startDate: '2026-09-07',
        days: [{ date: '2026-09-07' }],
      }).expect(400);
    });
  });

  describe('Отметки и итог недели (ТЗ 5.8)', () => {
    it('считает Sum = Σ(приходы) + Σ(ДЗ) + Exam + Bonus, не считая приход на экзамене', async () => {
      const token = await actor(ALL);
      const { groupId, nigina, week } = await setup(token);

      const response = await put(`${journalUrl(groupId)}/weeks/${week.id}`, token, {
        entries: [
          { studentId: nigina, date: '2026-09-07', attendance: 'PRESENT', score: 5 },
          { studentId: nigina, date: '2026-09-09', attendance: 'PRESENT', score: 4 },
        ],
        results: [{ studentId: nigina, bonus: 6, exam: 90 }],
      }).expect(200);

      const row = dataOf<WeekBody>(response).rows.find((item) => item.student.id === nigina);
      // Приход только за лекцию (1), ДЗ 5 + 4, экзамен 90, бонус 6.
      expect(row).toMatchObject({
        attendanceScore: 1,
        homeworkScore: 9,
        exam: 90,
        bonus: 6,
        sum: 106,
      });
    });

    it('опоздание засчитывается как приход', async () => {
      const token = await actor(ALL);
      const { groupId, nigina, week } = await setup(token);

      const response = await put(`${journalUrl(groupId)}/weeks/${week.id}`, token, {
        entries: [{ studentId: nigina, date: '2026-09-07', attendance: 'LATE' }],
      }).expect(200);

      expect(
        dataOf<WeekBody>(response).rows.find((item) => item.student.id === nigina),
      ).toMatchObject({ attendanceScore: 1, sum: 1 });
    });

    it('`null` снимает отметку, а не переданное поле её не трогает', async () => {
      const token = await actor(ALL);
      const { groupId, nigina, week } = await setup(token);
      const url = `${journalUrl(groupId)}/weeks/${week.id}`;

      await put(url, token, {
        entries: [{ studentId: nigina, date: '2026-09-07', attendance: 'PRESENT', score: 5 }],
      }).expect(200);

      // Правится только балл — посещаемость остаётся.
      const patched = await put(url, token, {
        entries: [{ studentId: nigina, date: '2026-09-07', score: 3 }],
      }).expect(200);
      expect(
        dataOf<WeekBody>(patched).rows.find((item) => item.student.id === nigina),
      ).toMatchObject({ attendanceScore: 1, homeworkScore: 3 });

      const cleared = await put(url, token, {
        entries: [{ studentId: nigina, date: '2026-09-07', attendance: null }],
      }).expect(200);
      expect(
        dataOf<WeekBody>(cleared).rows.find((item) => item.student.id === nigina),
      ).toMatchObject({ attendanceScore: 0, homeworkScore: 3 });
    });

    it('убранный день уносит свои отметки и меняет итог', async () => {
      const token = await actor(ALL);
      const { groupId, nigina, week } = await setup(token);
      const url = `${journalUrl(groupId)}/weeks/${week.id}`;

      await put(url, token, {
        entries: [
          { studentId: nigina, date: '2026-09-07', attendance: 'PRESENT', score: 5 },
          { studentId: nigina, date: '2026-09-09', score: 4 },
        ],
      }).expect(200);

      const shrunk = await put(url, token, { days: [{ date: '2026-09-07' }] }).expect(200);
      const body = dataOf<WeekBody>(shrunk);

      expect(body.days).toHaveLength(1);
      expect(body.rows.find((item) => item.student.id === nigina)).toMatchObject({
        homeworkScore: 5,
        sum: 6,
      });
    });

    it('400 на балл за ДЗ выше пяти и на неизвестную отметку', async () => {
      const token = await actor(ALL);
      const { groupId, nigina, week } = await setup(token);
      const url = `${journalUrl(groupId)}/weeks/${week.id}`;

      await put(url, token, {
        entries: [{ studentId: nigina, date: '2026-09-07', score: 6 }],
      }).expect(400);
      await put(url, token, {
        entries: [{ studentId: nigina, date: '2026-09-07', attendance: 'MAYBE' }],
      }).expect(400);
    });

    it('422 на отметку в день, которого в неделе нет', async () => {
      const token = await actor(ALL);
      const { groupId, nigina, week } = await setup(token);

      await put(`${journalUrl(groupId)}/weeks/${week.id}`, token, {
        entries: [{ studentId: nigina, date: '2026-09-08', attendance: 'PRESENT' }],
      }).expect(422);
    });

    it('422 на студента не из группы — отметка не ставится', async () => {
      const token = await actor(ALL);
      const { groupId, nigina, week } = await setup(token);
      const outsider = store.addStudent('Посторонний');

      await put(`${journalUrl(groupId)}/weeks/${week.id}`, token, {
        entries: [
          { studentId: nigina, date: '2026-09-07', attendance: 'PRESENT' },
          { studentId: outsider, date: '2026-09-07', attendance: 'PRESENT' },
        ],
      }).expect(422);

      const week1 = await get(`${journalUrl(groupId)}/weeks/${week.id}`, token).expect(200);
      expect(
        dataOf<WeekBody>(week1).rows.find((item) => item.student.id === nigina)?.attendanceScore,
      ).toBe(0);
    });

    it('404 на неделю соседней группы', async () => {
      const token = await actor(ALL);
      const { week } = await setup(token);
      const other = store.addGroup('Python-1');

      await get(`${journalUrl(other)}/weeks/${week.id}`, token).expect(404);
      await put(`${journalUrl(other)}/weeks/${week.id}`, token, {}).expect(404);
    });
  });

  describe('Отметить всех присутствующими', () => {
    it('заполняет пустые клетки и не трогает проставленные', async () => {
      const token = await actor(ALL);
      const { groupId, nigina, ali, week } = await setup(token);
      const url = `${journalUrl(groupId)}/weeks/${week.id}`;

      await put(url, token, {
        entries: [{ studentId: ali, date: '2026-09-07', attendance: 'ABSENT' }],
      }).expect(200);

      const response = await post(`${url}/mark-all-present`, token).expect(200);
      const body = dataOf<{ marked: number; week: WeekBody }>(response);

      // Свободны были три клетки из четырёх: пропуск Али остался как есть.
      expect(body.marked).toBe(3);
      const aliRow = body.week.rows.find((item) => item.student.id === ali);
      expect(aliRow?.entries[0]?.attendance).toBe('ABSENT');
      expect(aliRow?.entries[1]?.attendance).toBe('PRESENT');
      expect(body.week.rows.find((item) => item.student.id === nigina)?.attendanceScore).toBe(1);
    });

    it('с датой отмечается только один день', async () => {
      const token = await actor(ALL);
      const { groupId, week } = await setup(token);

      const response = await post(
        `${journalUrl(groupId)}/weeks/${week.id}/mark-all-present`,
        token,
        {
          date: '2026-09-07',
        },
      ).expect(200);

      expect(dataOf<{ marked: number }>(response).marked).toBe(2);
    });

    it('покинувший группу кнопкой не отмечается', async () => {
      const token = await actor(ALL);
      const groupId = store.addGroup();
      const left = store.addStudent('Ушедший');
      store.enroll(groupId, left, 'LEFT');

      const created = await post(`${journalUrl(groupId)}/weeks`, token, {
        startDate: '2026-09-07',
        days: [{ date: '2026-09-07' }],
      }).expect(201);
      const weekId = dataOf<WeekBody>(created).id;

      const response = await post(
        `${journalUrl(groupId)}/weeks/${weekId}/mark-all-present`,
        token,
      ).expect(200);

      expect(dataOf<{ marked: number }>(response).marked).toBe(0);
    });

    it('422 на дату, которой в неделе нет', async () => {
      const token = await actor(ALL);
      const { groupId, week } = await setup(token);

      await post(`${journalUrl(groupId)}/weeks/${week.id}/mark-all-present`, token, {
        date: '2026-09-08',
      }).expect(422);
    });
  });

  describe('Финализация недели (ТЗ 5.8, 5.9)', () => {
    it('начисляет коины по итогу и собирает отчёт Директору', async () => {
      const token = await actor(ALL);
      const { groupId, nigina, ali, week } = await setup(token);
      const url = `${journalUrl(groupId)}/weeks/${week.id}`;

      await put(url, token, {
        entries: [
          { studentId: nigina, date: '2026-09-07', attendance: 'PRESENT', score: 5 },
          { studentId: ali, date: '2026-09-07', attendance: 'ABSENT', score: 1 },
        ],
        results: [
          { studentId: nigina, bonus: 4, exam: 95 },
          { studentId: ali, exam: 50 },
        ],
      }).expect(200);

      const response = await post(`${url}/submit`, token).expect(200);
      const body = dataOf<{
        week: WeekBody;
        report: {
          groupName: string;
          coinsAwarded: number;
          awards: { studentId: string; sum: number; coins: number }[];
        };
      }>(response);

      // Нигина: 1 приход + 5 ДЗ + 95 экзамен + 4 бонус = 105 → 5 коинов.
      // Али: 0 + 1 + 50 = 51 → ничего.
      expect(body.report).toMatchObject({ groupName: 'Frontend-1', coinsAwarded: 5 });
      expect(body.report.awards).toEqual([
        { studentId: nigina, fullName: 'Каримова Нигина', sum: 105, coins: 5 },
      ]);
      expect(store.coins.get(nigina)).toBe(5);
      expect(store.coins.has(ali)).toBe(false);
      expect(body.week.submitted).toBe(true);
    });

    it('финализированная неделя больше не правится и не удаляется', async () => {
      const token = await actor(ALL);
      const { groupId, nigina, week } = await setup(token);
      const url = `${journalUrl(groupId)}/weeks/${week.id}`;

      await post(`${url}/submit`, token).expect(200);

      await put(url, token, {
        entries: [{ studentId: nigina, date: '2026-09-07', attendance: 'PRESENT' }],
      }).expect(422);
      await post(`${url}/mark-all-present`, token).expect(422);
      await del(url, token).expect(422);
    });

    it('409 на повторную финализацию — коины не начисляются дважды', async () => {
      const token = await actor(ALL);
      const { groupId, nigina, week } = await setup(token);
      const url = `${journalUrl(groupId)}/weeks/${week.id}`;

      await put(url, token, { results: [{ studentId: nigina, exam: 100 }] }).expect(200);
      await post(`${url}/submit`, token).expect(200);
      await post(`${url}/submit`, token).expect(409);

      expect(store.coins.get(nigina)).toBe(5);
    });

    it('422 на финализацию недели без учебных дней', async () => {
      const token = await actor(ALL);
      const { groupId, week } = await setup(token);
      const url = `${journalUrl(groupId)}/weeks/${week.id}`;

      // `days: []` DTO не пропускает, поэтому неделя без дней получается только
      // через хранилище — так же, как её мог бы оставить каскад в БД.
      const stored = store.weeks.get(week.id);
      if (stored === undefined) throw new Error('Неделя не заведена');
      stored.days = [];

      await post(`${url}/submit`, token).expect(422);
    });

    it('неделя без набравших порог финализируется без начислений', async () => {
      const token = await actor(ALL);
      const { groupId, week } = await setup(token);

      const response = await post(`${journalUrl(groupId)}/weeks/${week.id}/submit`, token).expect(
        200,
      );

      expect(dataOf<{ report: { coinsAwarded: number } }>(response).report.coinsAwarded).toBe(0);
      expect(store.coins.size).toBe(0);
    });
  });

  describe('Список недель', () => {
    it('отдаёт `{ data, meta }` со средним баллом и фильтром финализации', async () => {
      const token = await actor(ALL);
      const { groupId, nigina, week } = await setup(token);

      await put(`${journalUrl(groupId)}/weeks/${week.id}`, token, {
        results: [{ studentId: nigina, exam: 80 }],
      }).expect(200);
      await post(`${journalUrl(groupId)}/weeks`, token, {
        startDate: '2026-09-14',
        days: [{ date: '2026-09-14' }],
      }).expect(201);

      const list = await get(journalUrl(groupId), token).expect(200);
      const body = list.body as { data: WeekBody[]; meta: { total: number } };

      expect(body.meta).toMatchObject({ total: 2, page: 1, limit: 20 });
      expect(body.data.map((item) => item.weekNumber)).toEqual([1, 2]);
      // Средний по двум студентам: у Нигины 80, у Али 0.
      expect(body.data[0]?.averageSum).toBe(40);

      await post(`${journalUrl(groupId)}/weeks/${week.id}/submit`, token).expect(200);
      const submitted = await get(`${journalUrl(groupId)}?submitted=true`, token).expect(200);
      expect((submitted.body as { data: WeekBody[] }).data).toHaveLength(1);
    });

    it('недели соседней группы в список не попадают', async () => {
      const token = await actor(ALL);
      const { groupId } = await setup(token);
      const other = store.addGroup('Python-1');

      await post(`${journalUrl(other)}/weeks`, token, {
        startDate: '2026-10-05',
        days: [{ date: '2026-10-05' }],
      }).expect(201);

      const list = await get(journalUrl(groupId), token).expect(200);
      expect((list.body as { data: WeekBody[] }).data).toHaveLength(1);
    });

    it('400 на неизвестное поле сортировки и на `search`, которого у журнала нет', async () => {
      const token = await actor(ALL);
      const { groupId } = await setup(token);

      await get(`${journalUrl(groupId)}?sort=title`, token).expect(400);
      // `PageQueryDto` не наследует `search`: параметр, который молча ничего
      // не делает, хуже отсутствующего — здесь он честно отвергается.
      await get(`${journalUrl(groupId)}?search=что-нибудь`, token).expect(400);
    });
  });

  describe('Удаление недели', () => {
    it('убирает открытую неделю', async () => {
      const token = await actor(ALL);
      const { groupId, week } = await setup(token);

      const response = await del(`${journalUrl(groupId)}/weeks/${week.id}`, token).expect(200);
      expect(dataOf<{ weekNumber: number }>(response).weekNumber).toBe(1);

      await get(`${journalUrl(groupId)}/weeks/${week.id}`, token).expect(404);
    });

    it('освободившийся день можно занять новой неделей', async () => {
      const token = await actor(ALL);
      const { groupId, week } = await setup(token);

      await del(`${journalUrl(groupId)}/weeks/${week.id}`, token).expect(200);
      await post(`${journalUrl(groupId)}/weeks`, token, {
        startDate: '2026-09-07',
        days: [{ date: '2026-09-07' }],
      }).expect(201);
    });
  });

  describe('Ведущий и часы учебного дня (ТЗ 5.16, решение 0032)', () => {
    /**
     * Группа, у которой есть ментор. Часы зарплаты считаются по журналу,
     * а не по расписанию: слот — это план, журнал фиксирует факт (0018).
     */
    const setupWithMentor = (): { groupId: string; mentorId: string } => {
      const groupId = store.addGroup();
      const mentor = store.addEmployee(randomUUID(), 'Фаррух', 'Раҳимов');
      store.addGroupMentor(groupId, mentor.id);

      return { groupId, mentorId: mentor.id };
    };

    it('записывает ведущего и длительность и отдаёт их в дне недели', async () => {
      const token = await actor(ALL);
      const { groupId, mentorId } = setupWithMentor();

      const created = await post(`${journalUrl(groupId)}/weeks`, token, {
        startDate: '2026-09-07',
        days: [{ date: '2026-09-07', mentorId, durationMinutes: 90 }],
      }).expect(201);

      expect(dataOf<WeekBody>(created).days[0]).toMatchObject({
        date: '2026-09-07',
        durationMinutes: 90,
        mentor: { id: mentorId, firstName: 'Фаррух', lastName: 'Раҳимов' },
      });
    });

    it('день без ведущего и длительности остаётся законным: оба поля null', async () => {
      const token = await actor(ALL);
      const { groupId } = setupWithMentor();

      const created = await post(`${journalUrl(groupId)}/weeks`, token, {
        startDate: '2026-09-07',
        days: [{ date: '2026-09-07' }],
      }).expect(201);

      expect(dataOf<WeekBody>(created).days[0]).toMatchObject({
        mentor: null,
        durationMinutes: null,
      });
    });

    it('422 на постороннего сотрудника — неделя не заведена', async () => {
      const token = await actor(ALL);
      const groupId = store.addGroup();
      const outsider = store.addEmployee(randomUUID(), 'Чужой', 'Сотрудник');

      await post(`${journalUrl(groupId)}/weeks`, token, {
        startDate: '2026-09-07',
        days: [{ date: '2026-09-07', mentorId: outsider.id, durationMinutes: 90 }],
      }).expect(422);

      const list = await get(journalUrl(groupId), token).expect(200);
      expect(dataOf<unknown[]>(list)).toHaveLength(0);
    });

    it('правка недели заменяет ведущего вместе с набором дней', async () => {
      const token = await actor(ALL);
      const { groupId, mentorId } = setupWithMentor();
      const created = await post(`${journalUrl(groupId)}/weeks`, token, {
        startDate: '2026-09-07',
        days: [{ date: '2026-09-07', mentorId, durationMinutes: 90 }],
      }).expect(201);
      const weekId = dataOf<WeekBody>(created).id;

      // Набор дней заменяется целиком (правило 0018), поэтому непереданный
      // ведущий означает «снять», а не «оставить как было».
      const updated = await put(`${journalUrl(groupId)}/weeks/${weekId}`, token, {
        days: [{ date: '2026-09-07', durationMinutes: 120 }],
      }).expect(200);

      expect(dataOf<WeekBody>(updated).days[0]).toMatchObject({
        mentor: null,
        durationMinutes: 120,
      });
    });

    it('400 на длительность вне границ и на не-целое число минут', async () => {
      const token = await actor(ALL);
      const { groupId, mentorId } = setupWithMentor();

      for (const durationMinutes of [0, -30, 2000, 90.5]) {
        await post(`${journalUrl(groupId)}/weeks`, token, {
          startDate: '2026-09-07',
          days: [{ date: '2026-09-07', mentorId, durationMinutes }],
        }).expect(400);
      }
    });

    it('ведущий проверяется до записи: ни один день не заводится', async () => {
      const token = await actor(ALL);
      const { groupId, mentorId } = setupWithMentor();
      const outsider = store.addEmployee(randomUUID(), 'Чужой', 'Сотрудник');

      await post(`${journalUrl(groupId)}/weeks`, token, {
        startDate: '2026-09-07',
        days: [
          { date: '2026-09-07', mentorId, durationMinutes: 90 },
          { date: '2026-09-09', mentorId: outsider.id, durationMinutes: 90 },
        ],
      }).expect(422);

      expect(dataOf<unknown[]>(await get(journalUrl(groupId), token).expect(200))).toHaveLength(0);
    });
  });

  describe('OpenAPI', () => {
    it('пути журнала описаны, создание отвечает 201, финализация — 200', () => {
      const document = buildOpenApiDocument(app);

      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/groups/{groupId}/journal',
          '/api/v1/groups/{groupId}/journal/weeks',
          '/api/v1/groups/{groupId}/journal/weeks/{weekId}',
          '/api/v1/groups/{groupId}/journal/weeks/{weekId}/mark-all-present',
          '/api/v1/groups/{groupId}/journal/weeks/{weekId}/submit',
        ]),
      );

      const create = document.paths['/api/v1/groups/{groupId}/journal/weeks']?.post;
      expect(create?.responses['201']).toBeDefined();
      expect(create?.responses['200']).toBeUndefined();

      const submit = document.paths['/api/v1/groups/{groupId}/journal/weeks/{weekId}/submit']?.post;
      expect(submit?.responses['200']).toBeDefined();
      expect(submit?.responses['201']).toBeUndefined();
    });
  });
});
