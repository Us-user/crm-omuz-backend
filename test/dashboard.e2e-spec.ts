import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  AccountType,
  AttendanceMark,
  GraduateEmployment,
  GroupStatus,
  GroupStudentStatus,
  LeadType,
  StudentStatus,
} from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { DashboardModule } from 'src/dashboard/dashboard.module';
import type {
  AttendanceFactRow,
  DashboardLeftCourseRow,
  GraduateFactRow,
  LeadFactRow,
} from 'src/dashboard/dashboard.repository';
import { DashboardRepository } from 'src/dashboard/dashboard.repository';
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

const utc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

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
}

interface StoredEntry {
  dayId: string;
  /** `null` — клетка не отмечена: в счёт не идёт (правило сессии 0018). */
  mark: AttendanceMark | null;
}

interface StoredLead {
  createdAt: Date;
  type: LeadType;
  convertedStudentId: string | null;
  utmSource: string | null;
  course: { id: string; title: string } | null;
}

interface StoredMoney {
  at: Date;
  cents: number;
}

interface StoredGraduate {
  graduatedAt: Date;
  employment: GraduateEmployment | null;
}

interface StoredMembership {
  status: GroupStudentStatus;
  statusChangedAt: Date | null;
  groupId: string;
  groupName: string;
  courseId: string;
  courseTitle: string;
}

/**
 * Журнал, лиды, касса, выпуски и членства **вместе** — одно хранилище
 * подставляется на `DashboardRepository`.
 *
 * Отбор здесь **повторяет правила репозитория** (окно с невключающей правой
 * границей, неотмеченные клетки вне счёта, только статус `LEFT`, только живые
 * группы у менторов), а не подставляет готовые числа: иначе тест сравнивал бы
 * две реализации, а не правило.
 *
 * Соседние модули не поднимаются намеренно. У дашборда нет ни одного маршрута
 * записи, а данные ему поставляют **шесть** доменов: чтобы завести отметку
 * настоящим запросом, пришлось бы поднять `GroupJournalModule` с его
 * четырнадцатью методами репозитория, и так шесть раз. Что запросы Prisma
 * отбирают то же, что и хранилище, здесь не проверяется — это честно записано
 * в логе сессии, как и в 0025, 0029–0034.
 */
class InMemoryStore {
  readonly days: StoredDay[] = [];
  readonly entries: StoredEntry[] = [];
  readonly leads: StoredLead[] = [];
  readonly income: StoredMoney[] = [];
  readonly expenses: StoredMoney[] = [];
  readonly salaries: StoredMoney[] = [];
  readonly graduates: StoredGraduate[] = [];
  readonly memberships: StoredMembership[] = [];

  studentsByStatus: { status: StudentStatus; count: number }[] = [];
  groupsByStatus: { status: GroupStatus; count: number }[] = [];
  activeMentors = 0;

  /** Учебный день с отметками: `null` в списке — неотмеченная клетка. */
  seedDay(date: string, marks: (AttendanceMark | null)[]): StoredDay {
    const day: StoredDay = { id: randomUUID(), date: utc(date) };
    this.days.push(day);
    for (const mark of marks) this.entries.push({ dayId: day.id, mark });

    return day;
  }

  seedLead(createdAt: string, overrides: Partial<StoredLead> = {}): void {
    this.leads.push({
      createdAt: new Date(createdAt),
      type: LeadType.LEAD,
      convertedStudentId: null,
      utmSource: null,
      course: null,
      ...overrides,
    });
  }

  seedMoney(target: StoredMoney[], at: string, somoni: number): void {
    target.push({ at: utc(at), cents: Math.round(somoni * 100) });
  }

  seedGraduate(graduatedAt: string, employment: GraduateEmployment | null = null): void {
    this.graduates.push({ graduatedAt: utc(graduatedAt), employment });
  }

  seedMembership(
    status: GroupStudentStatus,
    statusChangedAt: string | null,
    course: { id: string; title: string } = { id: COURSE_ID, title: 'Frontend Basic' },
  ): void {
    this.memberships.push({
      status,
      statusChangedAt: statusChangedAt === null ? null : utc(statusChangedAt),
      groupId: GROUP_ID,
      groupName: 'Frontend-1',
      courseId: course.id,
      courseTitle: course.title,
    });
  }

  // ─── DashboardRepository (повторяет отбор репозитория) ───

  countStudentsByStatus(): Promise<{ status: StudentStatus; count: number }[]> {
    return Promise.resolve(this.studentsByStatus);
  }

  countGroupsByStatus(): Promise<{ status: GroupStatus; count: number }[]> {
    return Promise.resolve(this.groupsByStatus);
  }

  countActiveMentors(): Promise<number> {
    return Promise.resolve(this.activeMentors);
  }

  countLessonsOn(date: Date): Promise<number> {
    return Promise.resolve(this.days.filter((day) => same(day.date, date)).length);
  }

  aggregateAttendanceOn(date: Date): Promise<{ mark: AttendanceMark; count: number }[]> {
    const ids = new Set(this.days.filter((day) => same(day.date, date)).map((day) => day.id));

    return Promise.resolve(
      tallyMarks(this.entries.filter((entry) => ids.has(entry.dayId))).map(([mark, count]) => ({
        mark,
        count,
      })),
    );
  }

  findAttendanceFacts(from: Date, to: Date): Promise<AttendanceFactRow[]> {
    const days = this.days.filter((day) => day.date >= from && day.date < to);

    return Promise.resolve(
      days.flatMap((day) =>
        tallyMarks(this.entries.filter((entry) => entry.dayId === day.id)).map(
          ([mark, count]): AttendanceFactRow => ({ at: day.date, mark, count }),
        ),
      ),
    );
  }

  findLeadFacts(from: Date, to: Date): Promise<LeadFactRow[]> {
    return Promise.resolve(
      this.leads.filter((lead) => lead.createdAt >= from && lead.createdAt < to),
    );
  }

  sumIncome(from: Date, to: Date): Promise<number> {
    return Promise.resolve(sumWindow(this.income, from, to));
  }

  sumExpense(from: Date, to: Date): Promise<number> {
    return Promise.resolve(sumWindow(this.expenses, from, to));
  }

  sumSalary(from: Date, to: Date): Promise<number> {
    return Promise.resolve(sumWindow(this.salaries, from, to));
  }

  findGraduateFacts(from: Date, to: Date): Promise<GraduateFactRow[]> {
    return Promise.resolve(
      this.graduates.filter((row) => row.graduatedAt >= from && row.graduatedAt < to),
    );
  }

  findLeftCourseFacts(from: Date, to: Date): Promise<DashboardLeftCourseRow[]> {
    return Promise.resolve(
      this.memberships
        // Только уходы: переведённый курс не покидал (решение сессии 0012).
        .filter((row) => row.status === GroupStudentStatus.LEFT)
        .filter(
          (row) =>
            row.statusChangedAt !== null && row.statusChangedAt >= from && row.statusChangedAt < to,
        )
        .map((row) => ({
          statusChangedAt: row.statusChangedAt,
          group: {
            id: row.groupId,
            name: row.groupName,
            course: { id: row.courseId, title: row.courseTitle },
            branch: { id: BRANCH_ID, name: 'Садбарг' },
          },
        })),
    );
  }
}

const same = (a: Date, b: Date): boolean => a.getTime() === b.getTime();

const sumWindow = (rows: StoredMoney[], from: Date, to: Date): number =>
  rows.filter((row) => row.at >= from && row.at < to).reduce((sum, row) => sum + row.cents, 0);

/** Отметки в пары «марка → сколько»; неотмеченные (`null`) отбрасываются. */
const tallyMarks = (entries: StoredEntry[]): [AttendanceMark, number][] => {
  const counts = new Map<AttendanceMark, number>();

  for (const entry of entries) {
    if (entry.mark === null) continue;
    counts.set(entry.mark, (counts.get(entry.mark) ?? 0) + 1);
  }

  return [...counts.entries()];
};

// Настоящие v4-идентификаторы, а не рукописные (находка сессии 0024).
const GROUP_ID = randomUUID();
const COURSE_ID = randomUUID();
const OTHER_COURSE_ID = randomUUID();
const BRANCH_ID = randomUUID();

interface PeriodBody {
  from: string;
  to: string;
  months: number;
}

interface AttendanceCounts {
  present: number;
  late: number;
  absent: number;
  marked: number;
  attendanceRate: number | null;
}

interface SummaryBody {
  date: string;
  attendance: AttendanceCounts & { lessons: number };
  students: { active: number; noActive: number; finished: number; blocked: number; total: number };
  mentors: { active: number };
  groups: {
    recruiting: number;
    active: number;
    finished: number;
    cancelled: number;
    total: number;
  };
}

interface AttendanceBody {
  period: PeriodBody;
  totals: AttendanceCounts;
  byMonth: (AttendanceCounts & { month: string })[];
}

interface LeadsBody {
  period: PeriodBody;
  totals: {
    total: number;
    leads: number;
    clients: number;
    converted: number;
    clientRate: number | null;
    conversionRate: number | null;
  };
  byMonth: { month: string; total: number; clients: number; converted: number }[];
  byUtmSource: { source: string | null; count: number }[];
  byCourse: { course: { id: string; name: string } | null; count: number }[];
}

interface MoneyChangeBody {
  current: number;
  previous: number;
  change: number;
  changePercent: number | null;
}

interface IncomeBody {
  month: string;
  previousMonth: string;
  income: MoneyChangeBody;
  expense: MoneyChangeBody;
  salary: MoneyChangeBody;
  net: MoneyChangeBody;
}

interface GraduatesBody {
  period: PeriodBody;
  total: number;
  employment: Record<string, number>;
  employed: number;
  employmentRate: number | null;
  byMonth: { month: string; count: number }[];
}

interface LeftCoursesBody {
  period: PeriodBody;
  total: number;
  byMonth: { month: string; count: number }[];
  byCourse: { ref: { id: string; name: string }; count: number }[];
}

describe('Дашборд (e2e, хранилище в памяти)', () => {
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
        RateLimitModule,
        AuthModule,
        RbacModule,
        DashboardModule,
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
      .overrideProvider(DashboardRepository)
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

  const viewer = () => actor(['Permission.Dashboard.Views']);
  /** Директор: дашборд плюс раздел Accounting (только он и открывает деньги). */
  const director = () => actor(['Permission.Dashboard.Views', 'Permission.Accounting.Views']);

  const studentToken = async (): Promise<string> =>
    (await tokens.issuePair({ sub: randomUUID(), sid: randomUUID(), type: AccountType.STUDENT }))
      .accessToken;

  const get = (url: string, token: string) =>
    request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);

  const fetch = async <T>(url: string, token: string): Promise<T> =>
    dataOf<T>(await get(url, token).expect(200));

  describe('GET /dashboard/summary (ТЗ 5.2)', () => {
    it('отдаёт посещаемость дня и счётчики центра', async () => {
      store.seedDay('2026-08-03', [
        AttendanceMark.PRESENT,
        AttendanceMark.PRESENT,
        AttendanceMark.LATE,
        AttendanceMark.ABSENT,
      ]);
      store.seedDay('2026-08-03', [AttendanceMark.PRESENT]);
      store.studentsByStatus = [
        { status: StudentStatus.ACTIVE, count: 40 },
        { status: StudentStatus.FINISHED, count: 12 },
      ];
      store.groupsByStatus = [
        { status: GroupStatus.ACTIVE, count: 6 },
        { status: GroupStatus.RECRUITING, count: 2 },
      ];
      store.activeMentors = 4;

      const body = await fetch<SummaryBody>(
        '/api/v1/dashboard/summary?date=2026-08-03',
        await viewer(),
      );

      expect(body).toEqual({
        date: '2026-08-03',
        attendance: { lessons: 2, present: 3, late: 1, absent: 1, marked: 5, attendanceRate: 80 },
        students: { active: 40, noActive: 0, finished: 12, blocked: 0, total: 52 },
        mentors: { active: 4 },
        groups: { recruiting: 2, active: 6, finished: 0, cancelled: 0, total: 8 },
      });
    });

    it('неотмеченная клетка в счёт не идёт: «не отмечен» ≠ «отсутствовал»', async () => {
      store.seedDay('2026-08-03', [AttendanceMark.PRESENT, null, null]);

      const body = await fetch<SummaryBody>(
        '/api/v1/dashboard/summary?date=2026-08-03',
        await viewer(),
      );

      expect(body.attendance.marked).toBe(1);
      expect(body.attendance.absent).toBe(0);
      expect(body.attendance.attendanceRate).toBe(100);
    });

    it('опоздание считается приходом (ТЗ 5.8)', async () => {
      store.seedDay('2026-08-03', [AttendanceMark.LATE, AttendanceMark.ABSENT]);

      const body = await fetch<SummaryBody>(
        '/api/v1/dashboard/summary?date=2026-08-03',
        await viewer(),
      );

      expect(body.attendance).toMatchObject({ late: 1, absent: 1, attendanceRate: 50 });
    });

    it('отметки соседнего дня в сводку не попадают', async () => {
      store.seedDay('2026-08-02', [AttendanceMark.PRESENT, AttendanceMark.PRESENT]);
      store.seedDay('2026-08-03', [AttendanceMark.ABSENT]);

      const body = await fetch<SummaryBody>(
        '/api/v1/dashboard/summary?date=2026-08-03',
        await viewer(),
      );

      expect(body.attendance).toMatchObject({ lessons: 1, present: 0, absent: 1 });
    });

    it('день без занятий отдаёт нули и null вместо доли', async () => {
      const body = await fetch<SummaryBody>(
        '/api/v1/dashboard/summary?date=2026-08-03',
        await viewer(),
      );

      expect(body.attendance).toEqual({
        lessons: 0,
        present: 0,
        late: 0,
        absent: 0,
        marked: 0,
        attendanceRate: null,
      });
    });

    it('без даты открывается на сегодняшнем дне', async () => {
      const body = await fetch<SummaryBody>('/api/v1/dashboard/summary', await viewer());

      expect(body.date).toBe(new Date().toISOString().slice(0, 10));
    });

    it('400 на несуществующую дату', async () => {
      await get('/api/v1/dashboard/summary?date=2026-02-30', await viewer()).expect(400);
    });

    it('400 на дату в неверном формате', async () => {
      await get('/api/v1/dashboard/summary?date=03.08.2026', await viewer()).expect(400);
    });
  });

  describe('GET /dashboard/attendance (ТЗ 5.2)', () => {
    it('раскладывает отметки по месяцам и считает итог по периоду', async () => {
      store.seedDay('2026-04-06', [AttendanceMark.PRESENT, AttendanceMark.PRESENT]);
      store.seedDay('2026-06-02', [AttendanceMark.LATE, AttendanceMark.ABSENT]);

      const body = await fetch<AttendanceBody>(
        '/api/v1/dashboard/attendance?from=2026-04&to=2026-06',
        await viewer(),
      );

      expect(body.period).toEqual({ from: '2026-04', to: '2026-06', months: 3 });
      expect(body.totals).toEqual({
        present: 2,
        late: 1,
        absent: 1,
        marked: 4,
        attendanceRate: 75,
      });
      expect(body.byMonth).toEqual([
        { month: '2026-04', present: 2, late: 0, absent: 0, marked: 2, attendanceRate: 100 },
        { month: '2026-05', present: 0, late: 0, absent: 0, marked: 0, attendanceRate: null },
        { month: '2026-06', present: 0, late: 1, absent: 1, marked: 2, attendanceRate: 50 },
      ]);
    });

    it('месяц без занятий остаётся в ряду, а не пропадает', async () => {
      const body = await fetch<AttendanceBody>(
        '/api/v1/dashboard/attendance?from=2026-01&to=2026-03',
        await viewer(),
      );

      expect(body.byMonth.map(({ month }) => month)).toEqual(['2026-01', '2026-02', '2026-03']);
    });

    it('занятие вне периода в график не попадает', async () => {
      store.seedDay('2026-03-31', [AttendanceMark.PRESENT]);
      store.seedDay('2026-07-01', [AttendanceMark.PRESENT]);

      const body = await fetch<AttendanceBody>(
        '/api/v1/dashboard/attendance?from=2026-04&to=2026-06',
        await viewer(),
      );

      expect(body.totals.marked).toBe(0);
    });

    it('без периода показывается год', async () => {
      const body = await fetch<AttendanceBody>('/api/v1/dashboard/attendance', await viewer());

      expect(body.period.months).toBe(12);
      expect(body.byMonth).toHaveLength(12);
    });

    it('400 на перевёрнутый и на слишком длинный период', async () => {
      const token = await viewer();

      await get('/api/v1/dashboard/attendance?from=2026-06&to=2026-04', token).expect(400);
      await get('/api/v1/dashboard/attendance?from=2020-01&to=2026-08', token).expect(400);
    });

    it('400 на несуществующий и на неверно записанный месяц', async () => {
      const token = await viewer();

      await get('/api/v1/dashboard/attendance?to=2026-13', token).expect(400);
      await get('/api/v1/dashboard/attendance?to=08-2026', token).expect(400);
    });
  });

  describe('GET /dashboard/leads-stats (ТЗ 5.2)', () => {
    it('сводит воронку когортами месяцев', async () => {
      store.seedLead('2026-04-03T10:00:00.000Z', {
        type: LeadType.CLIENT,
        convertedStudentId: randomUUID(),
        utmSource: 'instagram',
        course: { id: COURSE_ID, title: 'Frontend Basic' },
      });
      store.seedLead('2026-04-09T10:00:00.000Z', { utmSource: 'instagram' });
      store.seedLead('2026-06-01T10:00:00.000Z', { type: LeadType.CLIENT });

      const body = await fetch<LeadsBody>(
        '/api/v1/dashboard/leads-stats?from=2026-04&to=2026-06',
        await viewer(),
      );

      expect(body.totals).toEqual({
        total: 3,
        leads: 1,
        clients: 2,
        converted: 1,
        clientRate: 66.67,
        conversionRate: 33.33,
      });
      expect(body.byMonth).toEqual([
        { month: '2026-04', total: 2, clients: 1, converted: 1 },
        { month: '2026-05', total: 0, clients: 0, converted: 0 },
        { month: '2026-06', total: 1, clients: 1, converted: 0 },
      ]);
    });

    it('разрез идёт по UTM-метке, строка «без метки» уходит вниз', async () => {
      store.seedLead('2026-04-01T10:00:00.000Z', { utmSource: 'instagram' });
      store.seedLead('2026-04-02T10:00:00.000Z', { utmSource: 'instagram' });
      store.seedLead('2026-04-03T10:00:00.000Z');

      const body = await fetch<LeadsBody>(
        '/api/v1/dashboard/leads-stats?from=2026-04&to=2026-04',
        await viewer(),
      );

      expect(body.byUtmSource).toEqual([
        { source: 'instagram', count: 2 },
        { source: null, count: 1 },
      ]);
    });

    it('разрез по курсу называет курс, необязательный курс идёт строкой null', async () => {
      store.seedLead('2026-04-01T10:00:00.000Z', {
        course: { id: COURSE_ID, title: 'Frontend Basic' },
      });
      store.seedLead('2026-04-02T10:00:00.000Z', {
        course: { id: OTHER_COURSE_ID, title: 'Python Basic' },
      });
      store.seedLead('2026-04-03T10:00:00.000Z');

      const body = await fetch<LeadsBody>(
        '/api/v1/dashboard/leads-stats?from=2026-04&to=2026-04',
        await viewer(),
      );

      expect(body.byCourse).toEqual([
        { course: { id: COURSE_ID, name: 'Frontend Basic' }, count: 1 },
        { course: { id: OTHER_COURSE_ID, name: 'Python Basic' }, count: 1 },
        { course: null, count: 1 },
      ]);
    });

    it('обращение вне периода в воронку не попадает', async () => {
      store.seedLead('2026-03-31T23:00:00.000Z');
      store.seedLead('2026-07-01T00:00:00.000Z');

      const body = await fetch<LeadsBody>(
        '/api/v1/dashboard/leads-stats?from=2026-04&to=2026-06',
        await viewer(),
      );

      expect(body.totals.total).toBe(0);
      expect(body.totals.conversionRate).toBeNull();
    });
  });

  describe('GET /dashboard/income (ТЗ 5.2)', () => {
    it('сравнивает месяц с предыдущим и считает итог', async () => {
      store.seedMoney(store.income, '2026-08-05', 1200);
      store.seedMoney(store.income, '2026-07-05', 1000);
      store.seedMoney(store.expenses, '2026-08-10', 300);
      store.seedMoney(store.expenses, '2026-07-10', 200);
      store.seedMoney(store.salaries, '2026-08-25', 500);
      store.seedMoney(store.salaries, '2026-07-25', 500);

      const body = await fetch<IncomeBody>(
        '/api/v1/dashboard/income?month=2026-08',
        await director(),
      );

      expect(body.month).toBe('2026-08');
      expect(body.previousMonth).toBe('2026-07');
      expect(body.income).toEqual({
        current: 1200,
        previous: 1000,
        change: 200,
        changePercent: 20,
      });
      expect(body.net).toEqual({ current: 400, previous: 300, change: 100, changePercent: 33.33 });
    });

    it('копейки не теряются: разность считается в тыйинах', async () => {
      store.seedMoney(store.income, '2026-08-05', 1200.3);
      store.seedMoney(store.income, '2026-07-05', 400.1);

      const body = await fetch<IncomeBody>(
        '/api/v1/dashboard/income?month=2026-08',
        await director(),
      );

      expect(body.income.change).toBe(800.2);
    });

    it('с пустого предыдущего месяца процента роста нет — это null', async () => {
      store.seedMoney(store.income, '2026-08-05', 500);

      const body = await fetch<IncomeBody>(
        '/api/v1/dashboard/income?month=2026-08',
        await director(),
      );

      expect(body.income).toEqual({
        current: 500,
        previous: 0,
        change: 500,
        changePercent: null,
      });
    });

    it('расход больше прихода даёт отрицательный итог — это законный ответ', async () => {
      store.seedMoney(store.income, '2026-08-05', 100);
      store.seedMoney(store.expenses, '2026-08-06', 400);

      const body = await fetch<IncomeBody>(
        '/api/v1/dashboard/income?month=2026-08',
        await director(),
      );

      expect(body.net.current).toBe(-300);
    });

    it('январь сравнивается с декабрём прошлого года', async () => {
      store.seedMoney(store.income, '2025-12-31', 900);

      const body = await fetch<IncomeBody>(
        '/api/v1/dashboard/income?month=2026-01',
        await director(),
      );

      expect(body.previousMonth).toBe('2025-12');
      expect(body.income.previous).toBe(900);
    });

    it('400 на несуществующий месяц', async () => {
      await get('/api/v1/dashboard/income?month=2026-13', await director()).expect(400);
    });
  });

  describe('GET /dashboard/graduates (ТЗ 5.2)', () => {
    it('считает трудоустройство по выясненным статусам и ряд выпусков', async () => {
      store.seedGraduate('2026-04-30', GraduateEmployment.WORK);
      store.seedGraduate('2026-04-30', GraduateEmployment.FREELANCER);
      store.seedGraduate('2026-06-30', GraduateEmployment.OPEN_TO_WORK);
      store.seedGraduate('2026-06-30');

      const body = await fetch<GraduatesBody>(
        '/api/v1/dashboard/graduates?from=2026-04&to=2026-06',
        await viewer(),
      );

      expect(body.total).toBe(4);
      expect(body.employed).toBe(2);
      // Знаменатель — трое с выясненным статусом, а не все четверо.
      expect(body.employmentRate).toBe(66.67);
      expect(body.employment.unknown).toBe(1);
      expect(body.byMonth).toEqual([
        { month: '2026-04', count: 2 },
        { month: '2026-05', count: 0 },
        { month: '2026-06', count: 2 },
      ]);
    });

    it('продолживший учёбу трудоустроенным не считается', async () => {
      store.seedGraduate('2026-04-30', GraduateEmployment.FURTHER_EDUCATION);
      store.seedGraduate('2026-04-30', GraduateEmployment.ENTREPRENEUR);

      const body = await fetch<GraduatesBody>(
        '/api/v1/dashboard/graduates?from=2026-04&to=2026-04',
        await viewer(),
      );

      expect(body.employed).toBe(1);
      expect(body.employmentRate).toBe(50);
    });

    it('статус, которого нет ни у кого, остаётся нулём, а не пропадает', async () => {
      store.seedGraduate('2026-04-30', GraduateEmployment.WORK);

      const body = await fetch<GraduatesBody>(
        '/api/v1/dashboard/graduates?from=2026-04&to=2026-04',
        await viewer(),
      );

      expect(body.employment).toEqual({
        OPEN_TO_WORK: 0,
        WORK: 1,
        FREELANCER: 0,
        FURTHER_EDUCATION: 0,
        ENTREPRENEUR: 0,
        unknown: 0,
      });
    });

    it('без выпусков доли нет — это null, а не ноль', async () => {
      const body = await fetch<GraduatesBody>(
        '/api/v1/dashboard/graduates?from=2026-04&to=2026-04',
        await viewer(),
      );

      expect(body.total).toBe(0);
      expect(body.employmentRate).toBeNull();
    });
  });

  describe('GET /dashboard/left-courses (ТЗ 5.2)', () => {
    it('считает отток по месяцам и по курсам', async () => {
      store.seedMembership(GroupStudentStatus.LEFT, '2026-04-15');
      store.seedMembership(GroupStudentStatus.LEFT, '2026-06-02');
      store.seedMembership(GroupStudentStatus.LEFT, '2026-06-20', {
        id: OTHER_COURSE_ID,
        title: 'Python Basic',
      });

      const body = await fetch<LeftCoursesBody>(
        '/api/v1/dashboard/left-courses?from=2026-04&to=2026-06',
        await viewer(),
      );

      expect(body.total).toBe(3);
      expect(body.byMonth).toEqual([
        { month: '2026-04', count: 1 },
        { month: '2026-05', count: 0 },
        { month: '2026-06', count: 2 },
      ]);
      expect(body.byCourse).toEqual([
        { ref: { id: COURSE_ID, name: 'Frontend Basic' }, count: 2 },
        { ref: { id: OTHER_COURSE_ID, name: 'Python Basic' }, count: 1 },
      ]);
    });

    it('переведённый в другую группу в отток не попадает', async () => {
      store.seedMembership(GroupStudentStatus.TRANSFERRED, '2026-04-15');
      store.seedMembership(GroupStudentStatus.FINISHED, '2026-04-16');

      const body = await fetch<LeftCoursesBody>(
        '/api/v1/dashboard/left-courses?from=2026-04&to=2026-06',
        await viewer(),
      );

      expect(body.total).toBe(0);
    });

    it('уход вне периода в отчёт не попадает', async () => {
      store.seedMembership(GroupStudentStatus.LEFT, '2026-03-31');
      store.seedMembership(GroupStudentStatus.LEFT, '2026-07-01');

      const body = await fetch<LeftCoursesBody>(
        '/api/v1/dashboard/left-courses?from=2026-04&to=2026-06',
        await viewer(),
      );

      expect(body.total).toBe(0);
      expect(body.byCourse).toEqual([]);
    });
  });

  describe('Права (ТЗ 3.2, 3.8)', () => {
    it('401 без токена', async () => {
      await request(app.getHttpServer()).get('/api/v1/dashboard/summary').expect(401);
    });

    it('403 студенту — у него свой кабинет', async () => {
      await get('/api/v1/dashboard/summary', await studentToken()).expect(403);
    });

    it('403 сотруднику без прав', async () => {
      await get('/api/v1/dashboard/summary', await actor([])).expect(403);
    });

    it('право на дашборд НЕ открывает денежную витрину', async () => {
      const token = await viewer();

      await get('/api/v1/dashboard/summary', token).expect(200);
      await get('/api/v1/dashboard/income', token).expect(403);
    });

    it('право на бухгалтерию без права на дашборд денежную витрину тоже не открывает', async () => {
      await get('/api/v1/dashboard/income', await actor(['Permission.Accounting.Views'])).expect(
        403,
      );
    });

    it('оба права вместе открывают денежную витрину', async () => {
      await get('/api/v1/dashboard/income', await director()).expect(200);
    });

    it('право на отток дашборд не открывает', async () => {
      await get(
        '/api/v1/dashboard/left-courses',
        await actor(['Permission.LeftCourses.Views']),
      ).expect(403);
    });

    it('одно право на дашборд открывает все пять неденежных витрин', async () => {
      const token = await viewer();

      for (const path of ['summary', 'attendance', 'leads-stats', 'graduates', 'left-courses']) {
        await get(`/api/v1/dashboard/${path}`, token).expect(200);
      }
    });
  });

  describe('OpenAPI', () => {
    it('шесть путей ТЗ 5.2 описаны, и у каждого только get — дашборд ничего не меняет', () => {
      const paths = (buildOpenApiDocument(app) as { paths: Record<string, object> }).paths;

      for (const path of [
        'summary',
        'attendance',
        'leads-stats',
        'income',
        'graduates',
        'left-courses',
      ]) {
        const item = paths[`/api/v1/dashboard/${path}`];

        expect(item).toBeDefined();
        expect(Object.keys(item ?? {})).toEqual(['get']);
      }
    });

    it('пагинации у дашборда нет: `page` в параметрах не описан', () => {
      const { paths } = buildOpenApiDocument(app) as unknown as {
        paths: Record<string, { get?: { parameters?: { name: string }[] } }>;
      };
      const parameters = paths['/api/v1/dashboard/attendance']?.get?.parameters ?? [];

      expect(parameters.map(({ name }) => name)).toEqual(['from', 'to']);
    });
  });
});
