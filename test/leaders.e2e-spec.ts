import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountType, GroupStudentStatus } from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import type { ScoredStudent } from 'src/leaders/leaders';
import { LeadersModule } from 'src/leaders/leaders.module';
import type {
  LeaderStudentRow,
  LeadersScope,
  MonthlyWinnerInput,
  MonthlyWinnerRow,
} from 'src/leaders/leaders.repository';
import { LeadersRepository } from 'src/leaders/leaders.repository';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { ActivityCategory } from 'src/performance/performance';
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
}

interface StoredGroup {
  id: string;
  name: string;
  courseId: string;
  courseTitle: string;
}

interface StoredWeek {
  id: string;
  groupId: string;
  startDate: Date;
  submittedAt: Date | null;
}

// Настоящие v4-идентификаторы, а не рукописные: `@IsUUID()` проверяет вариант,
// и «44444444-…» не прошёл бы валидацию фильтра — 400 вместо среза по курсу.
const COURSE_ID = randomUUID();
const OTHER_COURSE_ID = randomUUID();

/**
 * Студенты, группы, членства, недели журнала, их итоги и снимки месяцев вместе.
 *
 * Хранилище **повторяет правила выборки**, а не подставляет готовые числа:
 * в живой рейтинг идут только финализированные недели и только учащиеся сейчас,
 * а в снимок месяца — недели этого месяца **без** фильтра по сегодняшнему
 * статусу. Разведённые заглушки проверяли бы не те решения, ради которых
 * сессия и делалась.
 */
class InMemoryLeadersStore {
  readonly students = new Map<string, StoredStudent>();
  readonly groups = new Map<string, StoredGroup>();
  readonly memberships: { groupId: string; studentId: string; status: GroupStudentStatus }[] = [];
  readonly weeks = new Map<string, StoredWeek>();
  readonly results: { weekId: string; studentId: string; sum: number }[] = [];
  readonly winners: MonthlyWinnerRow[] = [];
  readonly employeesByAccount = new Map<string, string>();

  addStudent(lastName = 'Каримова', firstName = 'Нигина'): string {
    const id = randomUUID();
    this.students.set(id, { id, firstName, lastName });

    return id;
  }

  addGroup(name = 'Frontend-1', courseId = COURSE_ID, courseTitle = 'Frontend Basic'): string {
    const id = randomUUID();
    this.groups.set(id, { id, name, courseId, courseTitle });

    return id;
  }

  addEmployee(accountId: string): string {
    const id = randomUUID();
    this.employeesByAccount.set(accountId, id);

    return id;
  }

  enroll(
    groupId: string,
    studentId: string,
    status: GroupStudentStatus = GroupStudentStatus.ACTIVE,
  ): void {
    this.memberships.push({ groupId, studentId, status });
  }

  /** Неделя журнала. `submitted: false` — открытая: в балл она не входит. */
  addWeek(groupId: string, startDate: string, submitted = true): string {
    const id = randomUUID();
    this.weeks.set(id, {
      id,
      groupId,
      startDate: new Date(`${startDate}T00:00:00.000Z`),
      submittedAt: submitted ? new Date('2026-07-01T09:00:00.000Z') : null,
    });

    return id;
  }

  addResult(weekId: string, studentId: string, sum: number): void {
    this.results.push({ weekId, studentId, sum });
  }

  /** Правка журнала задним числом: снимок от неё меняться не должен. */
  rewriteResult(studentId: string, sum: number): void {
    for (const result of this.results) {
      if (result.studentId === studentId) result.sum = sum;
    }
  }

  // ─── Общие правила выборки ───

  private averageOf(sums: number[]): number | null {
    return sums.length === 0 ? null : sums.reduce((total, sum) => total + sum, 0) / sums.length;
  }

  private weekMatches(week: StoredWeek, scope: LeadersScope): boolean {
    if (week.submittedAt === null) return false;
    if (scope.groupId !== undefined && week.groupId !== scope.groupId) return false;
    if (
      scope.courseId !== undefined &&
      this.groups.get(week.groupId)?.courseId !== scope.courseId
    ) {
      return false;
    }

    return true;
  }

  private isRanked(studentId: string, scope: LeadersScope): boolean {
    return this.memberships.some((membership) => {
      if (membership.studentId !== studentId) return false;
      if (membership.status !== GroupStudentStatus.ACTIVE) return false;
      if (scope.groupId !== undefined && membership.groupId !== scope.groupId) return false;
      if (
        scope.courseId !== undefined &&
        this.groups.get(membership.groupId)?.courseId !== scope.courseId
      ) {
        return false;
      }

      return true;
    });
  }

  // ─── LeadersRepository ───

  findScores(scope: LeadersScope): Promise<ScoredStudent[]> {
    return Promise.resolve(
      [...this.students.keys()].flatMap((studentId) => {
        if (!this.isRanked(studentId, scope)) return [];

        const sums = this.results.flatMap((result) => {
          if (result.studentId !== studentId) return [];
          const week = this.weeks.get(result.weekId);

          return week && this.weekMatches(week, scope) ? [result.sum] : [];
        });
        const average = this.averageOf(sums);

        return average === null ? [] : [{ studentId, average, weeksCount: sums.length }];
      }),
    );
  }

  findMonthScores(monthStart: Date, nextMonth: Date): Promise<ScoredStudent[]> {
    return Promise.resolve(
      [...this.students.keys()].flatMap((studentId) => {
        const sums = this.results.flatMap((result) => {
          if (result.studentId !== studentId) return [];
          const week = this.weeks.get(result.weekId);
          if (!week || week.submittedAt === null) return [];
          const time = week.startDate.getTime();

          return time >= monthStart.getTime() && time < nextMonth.getTime() ? [result.sum] : [];
        });
        const average = this.averageOf(sums);

        return average === null ? [] : [{ studentId, average, weeksCount: sums.length }];
      }),
    );
  }

  findStudents(ids: string[]): Promise<LeaderStudentRow[]> {
    return Promise.resolve(
      ids.flatMap((id) => {
        const student = this.students.get(id);
        if (!student) return [];

        return [
          {
            id: student.id,
            firstName: student.firstName,
            lastName: student.lastName,
            photoUrl: null,
            groups: this.memberships
              .filter((m) => m.studentId === id && m.status === GroupStudentStatus.ACTIVE)
              .map((m) => {
                const group = this.groups.get(m.groupId);

                return {
                  group: {
                    id: m.groupId,
                    name: group?.name ?? '',
                    course: { id: group?.courseId ?? '', title: group?.courseTitle ?? '' },
                  },
                };
              }),
          },
        ];
      }),
    );
  }

  findWinners(month: Date): Promise<MonthlyWinnerRow[]> {
    return Promise.resolve(
      this.winners
        .filter((winner) => winner.month.getTime() === month.getTime())
        .sort((a, b) => a.place - b.place),
    );
  }

  findLatestClosedMonth(): Promise<Date | null> {
    const months = this.winners.map(({ month }) => month.getTime());

    return Promise.resolve(months.length === 0 ? null : new Date(Math.max(...months)));
  }

  countWinners(month: Date): Promise<number> {
    return Promise.resolve(
      this.winners.filter((winner) => winner.month.getTime() === month.getTime()).length,
    );
  }

  createWinners(
    month: Date,
    winners: MonthlyWinnerInput[],
    createdById: string | null,
  ): Promise<MonthlyWinnerRow[]> {
    for (const winner of winners) {
      const student = this.students.get(winner.studentId);

      this.winners.push({
        id: randomUUID(),
        month,
        place: winner.place,
        averageScore: winner.averageScore as unknown as MonthlyWinnerRow['averageScore'],
        weeksCount: winner.weeksCount,
        createdAt: new Date('2026-07-01T09:00:00.000Z'),
        student: {
          id: winner.studentId,
          firstName: student?.firstName ?? '',
          lastName: student?.lastName ?? '',
          photoUrl: null,
        },
        createdBy:
          createdById === null
            ? null
            : { id: createdById, firstName: 'Фаррух', lastName: 'Раҳимов' },
      });
    }

    return this.findWinners(month);
  }

  deleteWinners(month: Date): Promise<number> {
    const before = this.winners.length;
    for (let index = this.winners.length - 1; index >= 0; index -= 1) {
      if (this.winners[index]?.month.getTime() === month.getTime()) this.winners.splice(index, 1);
    }

    return Promise.resolve(before - this.winners.length);
  }

  findEmployeeByAccount(accountId: string): Promise<{ id: string } | null> {
    const id = this.employeesByAccount.get(accountId);

    return Promise.resolve(id === undefined ? null : { id });
  }
}

interface LeaderItem {
  position: number;
  isTopStudent: boolean;
  student: { id: string; lastName: string };
  averageScore: number;
  category: ActivityCategory;
  categoryTitle: string;
  weeksCount: number;
  groups: { id: string; name: string; courseId: string; courseTitle: string }[];
}

interface WinnersBody {
  month: string | null;
  closed: boolean;
  closedAt: string | null;
  closedBy: { id: string; lastName: string } | null;
  winners: {
    place: number;
    student: { id: string; lastName: string };
    averageScore: number;
    weeksCount: number;
    category: ActivityCategory;
  }[];
}

/** Месяц заведомо в прошлом относительно любого прогона тестов. */
const PAST_MONTH = '2026-06';
const PREVIOUS_MONTH = '2026-05';

describe('Лидеры, рейтинг и победители месяца (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryLeadersStore;
  let rbac: InMemoryRbacRepository;
  let tokens: TokenService;

  beforeEach(async () => {
    store = new InMemoryLeadersStore();
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
        LeadersModule,
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
      .overrideProvider(LeadersRepository)
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

  const viewer = () => actor(['Permission.Leaders.Views']);
  const closer = () => actor(['Permission.Leaders.Views', 'Permission.Leaders.ManageWinners']);

  const studentToken = async (): Promise<string> =>
    (await tokens.issuePair({ sub: randomUUID(), sid: randomUUID(), type: AccountType.STUDENT }))
      .accessToken;

  const get = (url: string, token: string) =>
    request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);

  const post = (url: string, token: string, body: object) =>
    request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${token}`).send(body);

  const del = (url: string, token: string) =>
    request(app.getHttpServer()).delete(url).set('Authorization', `Bearer ${token}`);

  /**
   * Студент в группе с одной закрытой неделей на каждый итог. Даты недель идут
   * подряд внутри `month`, чтобы снимок месяца брал их все.
   */
  const studentWithSums = (
    sums: number[],
    options: { lastName?: string; groupId?: string; month?: string; studying?: boolean } = {},
  ): string => {
    const id = store.addStudent(options.lastName ?? 'Каримова');
    const groupId = options.groupId ?? store.addGroup(`Group-${options.lastName ?? 'K'}`);
    store.enroll(
      groupId,
      id,
      options.studying === false ? GroupStudentStatus.FINISHED : GroupStudentStatus.ACTIVE,
    );

    sums.forEach((sum, index) => {
      const day = String(index * 7 + 1).padStart(2, '0');
      const weekId = store.addWeek(groupId, `${options.month ?? PAST_MONTH}-${day}`);
      store.addResult(weekId, id, sum);
    });

    return id;
  };

  describe('Доступ', () => {
    it('без токена — 401 на рейтинге и на победителях', async () => {
      await request(app.getHttpServer()).get('/api/v1/leaders').expect(401);
      await request(app.getHttpServer()).get('/api/v1/leaders/winners').expect(401);
    });

    it('студенту рейтинг центра закрыт — 403 (у него есть /me/performance)', async () => {
      const token = await studentToken();

      await get('/api/v1/leaders', token).expect(403);
      await get('/api/v1/leaders/winners', token).expect(403);
    });

    it('сотрудник без прав — 403', async () => {
      await get('/api/v1/leaders', await actor([])).expect(403);
    });

    it('право на студентов рейтинг не открывает', async () => {
      await get('/api/v1/leaders', await actor(['Permission.Students.Views'])).expect(403);
    });

    it('право на просмотр рейтинга не даёт закрывать месяц', async () => {
      await post('/api/v1/leaders/winners', await viewer(), { month: PAST_MONTH }).expect(403);
    });

    it('право на закрытие месяца не заменяет право на просмотр', async () => {
      const token = await actor(['Permission.Leaders.ManageWinners']);

      await get('/api/v1/leaders', token).expect(403);
      await get('/api/v1/leaders/winners', token).expect(403);
    });

    it('снятие снимка требует права на закрытие, а не на просмотр', async () => {
      await del(`/api/v1/leaders/winners/${PAST_MONTH}`, await viewer()).expect(403);
    });
  });

  describe('Рейтинг центра (ТЗ 5.13)', () => {
    it('строит список по убыванию балла с местами и короной у первого', async () => {
      studentWithSums([96], { lastName: 'Алиев' });
      studentWithSums([80], { lastName: 'Салимов' });
      studentWithSums([50], { lastName: 'Юсупов' });

      const response = await get('/api/v1/leaders', await viewer()).expect(200);
      const items = dataOf<LeaderItem[]>(response);

      expect(
        items.map(({ student, position, isTopStudent }) => [
          student.lastName,
          position,
          isTopStudent,
        ]),
      ).toEqual([
        ['Алиев', 1, true],
        ['Салимов', 2, false],
        ['Юсупов', 3, false],
      ]);
    });

    it('отдаёт { data, meta } с топ-3 в meta.top', async () => {
      ['A', 'B', 'C', 'D'].forEach((lastName, index) =>
        studentWithSums([100 - index * 10], { lastName }),
      );

      const response = await get('/api/v1/leaders', await viewer()).expect(200);
      const meta = metaOf<{ total: number; page: number; top: LeaderItem[] }>(response);

      expect(meta).toMatchObject({ total: 4, page: 1 });
      expect(meta.top.map(({ student }) => student.lastName)).toEqual(['A', 'B', 'C']);
    });

    it('на второй странице пьедестал остаётся в meta', async () => {
      ['A', 'B', 'C', 'D'].forEach((lastName, index) =>
        studentWithSums([100 - index * 10], { lastName }),
      );

      const response = await get('/api/v1/leaders?page=2&limit=2', await viewer()).expect(200);

      expect(dataOf<LeaderItem[]>(response).map(({ student }) => student.lastName)).toEqual([
        'C',
        'D',
      ]);
      expect(
        metaOf<{ top: LeaderItem[] }>(response).top.map(({ student }) => student.lastName),
      ).toEqual(['A', 'B', 'C']);
    });

    it('места считаются по всему рейтингу, а не по странице', async () => {
      ['A', 'B', 'C'].forEach((lastName, index) =>
        studentWithSums([100 - index * 10], { lastName }),
      );

      const response = await get('/api/v1/leaders?page=3&limit=1', await viewer()).expect(200);

      expect(dataOf<LeaderItem[]>(response)[0]).toMatchObject({ position: 3, isTopStudent: false });
    });

    it('при равенстве баллов корона у обоих', async () => {
      studentWithSums([90], { lastName: 'Алиев' });
      studentWithSums([90], { lastName: 'Салимов' });

      const items = dataOf<LeaderItem[]>(await get('/api/v1/leaders', await viewer()).expect(200));

      expect(items.every(({ position, isTopStudent }) => position === 1 && isTopStudent)).toBe(
        true,
      );
    });

    // Решение сессии 0019: открытая неделя заводится с нулевыми итогами
    // на весь состав, и её учёт обрушивал бы балл каждый понедельник.
    it('открытая неделя в рейтинг не входит', async () => {
      const groupId = store.addGroup('Frontend-1');
      const id = studentWithSums([100], { lastName: 'Алиев', groupId });
      const openWeek = store.addWeek(groupId, `${PAST_MONTH}-22`, false);
      store.addResult(openWeek, id, 0);

      const items = dataOf<LeaderItem[]>(await get('/api/v1/leaders', await viewer()).expect(200));

      expect(items[0]).toMatchObject({ averageScore: 100, weeksCount: 1 });
    });

    // Иначе корона навсегда осталась бы у выпускника прошлого года.
    it('не учащийся сейчас в рейтинг не попадает', async () => {
      studentWithSums([100], { lastName: 'Выпускник', studying: false });
      studentWithSums([60], { lastName: 'Учащийся' });

      const response = await get('/api/v1/leaders', await viewer()).expect(200);
      const items = dataOf<LeaderItem[]>(response);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ position: 1, isTopStudent: true });
      expect(items[0]?.student.lastName).toBe('Учащийся');
    });

    it('категория выводится из балла', async () => {
      studentWithSums([96], { lastName: 'Алиев' });

      const items = dataOf<LeaderItem[]>(await get('/api/v1/leaders', await viewer()).expect(200));

      expect(items[0]).toMatchObject({
        category: ActivityCategory.ChatGpt,
        categoryTitle: 'ChatGPT',
      });
    });

    it('строка несёт действующие группы студента', async () => {
      const groupId = store.addGroup('Frontend-1');
      studentWithSums([90], { lastName: 'Алиев', groupId });

      const items = dataOf<LeaderItem[]>(await get('/api/v1/leaders', await viewer()).expect(200));

      expect(items[0]?.groups).toEqual([
        { id: groupId, name: 'Frontend-1', courseId: COURSE_ID, courseTitle: 'Frontend Basic' },
      ]);
    });

    // `asc` показывает отстающих: категория Black list существует ровно затем.
    it('order=asc переворачивает показ, но не нумерацию', async () => {
      studentWithSums([96], { lastName: 'Алиев' });
      studentWithSums([40], { lastName: 'Юсупов' });

      const response = await get('/api/v1/leaders?order=asc', await viewer()).expect(200);

      expect(
        dataOf<LeaderItem[]>(response).map(({ student, position }) => [student.lastName, position]),
      ).toEqual([
        ['Юсупов', 2],
        ['Алиев', 1],
      ]);
    });

    it('пустой рейтинг отдаёт пустые data и top', async () => {
      const response = await get('/api/v1/leaders', await viewer()).expect(200);

      expect(dataOf<LeaderItem[]>(response)).toEqual([]);
      expect(metaOf<{ total: number; top: LeaderItem[] }>(response)).toMatchObject({
        total: 0,
        top: [],
      });
    });

    it('400 на неизвестное поле сортировки и на не-UUID в фильтре', async () => {
      const token = await viewer();

      await get('/api/v1/leaders?sort=lastName', token).expect(400);
      await get('/api/v1/leaders?groupId=не-uuid', token).expect(400);
    });
  });

  describe('Срез рейтинга по группе и курсу (ТЗ 5.13)', () => {
    it('балл считается по неделям среза, а не общий', async () => {
      // Один студент в двух группах: в первой он отличник, во второй — нет.
      // Общий балл усредняет оба курса, а срез должен показывать свой.
      const strong = store.addGroup('Frontend-1');
      const weak = store.addGroup('Python-1', OTHER_COURSE_ID, 'Python Basic');
      const id = store.addStudent('Алиев');
      store.enroll(strong, id);
      store.enroll(weak, id);
      store.addResult(store.addWeek(strong, `${PAST_MONTH}-01`), id, 100);
      store.addResult(store.addWeek(weak, `${PAST_MONTH}-08`), id, 40);

      const token = await viewer();
      const all = dataOf<LeaderItem[]>(await get('/api/v1/leaders', token).expect(200));
      const inStrong = dataOf<LeaderItem[]>(
        await get(`/api/v1/leaders?groupId=${strong}`, token).expect(200),
      );
      const inWeak = dataOf<LeaderItem[]>(
        await get(`/api/v1/leaders?groupId=${weak}`, token).expect(200),
      );

      expect(all[0]?.averageScore).toBe(70);
      expect(inStrong[0]).toMatchObject({ averageScore: 100, category: ActivityCategory.ChatGpt });
      expect(inWeak[0]).toMatchObject({ averageScore: 40, category: ActivityCategory.BlackList });
    });

    it('студенты соседней группы в срез не попадают', async () => {
      const mine = store.addGroup('Frontend-1');
      studentWithSums([90], { lastName: 'Алиев', groupId: mine });
      studentWithSums([95], { lastName: 'Чужой' });

      const items = dataOf<LeaderItem[]>(
        await get(`/api/v1/leaders?groupId=${mine}`, await viewer()).expect(200),
      );

      expect(items).toHaveLength(1);
      expect(items[0]?.student.lastName).toBe('Алиев');
    });

    it('срез по курсу собирает все его группы', async () => {
      const first = store.addGroup('Frontend-1');
      const second = store.addGroup('Frontend-2');
      studentWithSums([90], { lastName: 'Алиев', groupId: first });
      studentWithSums([80], { lastName: 'Салимов', groupId: second });
      studentWithSums([95], {
        lastName: 'Питонист',
        groupId: store.addGroup('Python-1', OTHER_COURSE_ID),
      });

      const items = dataOf<LeaderItem[]>(
        await get(`/api/v1/leaders?courseId=${COURSE_ID}`, await viewer()).expect(200),
      );

      expect(items.map(({ student }) => student.lastName)).toEqual(['Алиев', 'Салимов']);
    });

    it('неизвестная группа в фильтре даёт пустой рейтинг, а не ошибку', async () => {
      studentWithSums([90], { lastName: 'Алиев' });

      const response = await get(`/api/v1/leaders?groupId=${randomUUID()}`, await viewer()).expect(
        200,
      );

      expect(dataOf<LeaderItem[]>(response)).toEqual([]);
    });
  });

  describe('Закрытие месяца (ТЗ 5.13)', () => {
    it('фиксирует топ-3 и подписывает тем, кто закрыл', async () => {
      ['A', 'B', 'C', 'D'].forEach((lastName, index) =>
        studentWithSums([100 - index * 10], { lastName }),
      );

      const response = await post('/api/v1/leaders/winners', await closer(), {
        month: PAST_MONTH,
      }).expect(201);
      const body = dataOf<WinnersBody>(response);

      expect(body).toMatchObject({ month: PAST_MONTH, closed: true });
      expect(body.closedBy).not.toBeNull();
      expect(body.winners.map(({ student, place }) => [student.lastName, place])).toEqual([
        ['A', 1],
        ['B', 2],
        ['C', 3],
      ]);
    });

    // Главное свойство снимка: он не пересчитывается.
    it('правка журнала задним числом победителей не меняет', async () => {
      const winner = studentWithSums([100], { lastName: 'Алиев' });
      studentWithSums([50], { lastName: 'Салимов' });
      const token = await closer();

      await post('/api/v1/leaders/winners', token, { month: PAST_MONTH }).expect(201);

      // Победителю обнулили все итоги — снимок обязан остаться прежним.
      store.rewriteResult(winner, 0);

      const body = dataOf<WinnersBody>(
        await get(`/api/v1/leaders/winners?month=${PAST_MONTH}`, token).expect(200),
      );

      expect(body.winners[0]).toMatchObject({ place: 1, averageScore: 100 });
      expect(body.winners[0]?.student.lastName).toBe('Алиев');
    });

    // Отличие от живого рейтинга: снимок описывает, кто учился лучше тогда.
    it('в снимок попадает и тот, кто уже не учится', async () => {
      studentWithSums([100], { lastName: 'Выпускник', studying: false });
      studentWithSums([60], { lastName: 'Учащийся' });

      const body = dataOf<WinnersBody>(
        await post('/api/v1/leaders/winners', await closer(), { month: PAST_MONTH }).expect(201),
      );

      expect(body.winners.map(({ student }) => student.lastName)).toEqual([
        'Выпускник',
        'Учащийся',
      ]);
    });

    it('недели соседнего месяца в снимок не идут', async () => {
      studentWithSums([100], { lastName: 'Майский', month: PREVIOUS_MONTH });
      studentWithSums([60], { lastName: 'Июньский', month: PAST_MONTH });

      const body = dataOf<WinnersBody>(
        await post('/api/v1/leaders/winners', await closer(), { month: PAST_MONTH }).expect(201),
      );

      expect(body.winners).toHaveLength(1);
      expect(body.winners[0]?.student.lastName).toBe('Июньский');
    });

    it('открытая неделя месяца в снимок не идёт', async () => {
      const groupId = store.addGroup('Frontend-1');
      const id = store.addStudent('Алиев');
      store.enroll(groupId, id);
      store.addResult(store.addWeek(groupId, `${PAST_MONTH}-01`, false), id, 100);

      await post('/api/v1/leaders/winners', await closer(), { month: PAST_MONTH }).expect(422);
    });

    it('places ограничивает число мест', async () => {
      ['A', 'B', 'C'].forEach((lastName, index) =>
        studentWithSums([100 - index * 10], { lastName }),
      );

      const body = dataOf<WinnersBody>(
        await post('/api/v1/leaders/winners', await closer(), {
          month: PAST_MONTH,
          places: 1,
        }).expect(201),
      );

      expect(body.winners).toHaveLength(1);
    });

    it('при ничьей на последнем месте в снимок попадают все, кто его занял', async () => {
      studentWithSums([100], { lastName: 'A' });
      studentWithSums([90], { lastName: 'B' });
      studentWithSums([90], { lastName: 'C' });

      const body = dataOf<WinnersBody>(
        await post('/api/v1/leaders/winners', await closer(), {
          month: PAST_MONTH,
          places: 2,
        }).expect(201),
      );

      expect(body.winners).toHaveLength(3);
      expect(body.winners.map(({ place }) => place)).toEqual([1, 2, 2]);
    });

    it('повторное закрытие — 409, и снимок не изменился', async () => {
      studentWithSums([100], { lastName: 'Алиев' });
      const token = await closer();

      await post('/api/v1/leaders/winners', token, { month: PAST_MONTH }).expect(201);
      await post('/api/v1/leaders/winners', token, { month: PAST_MONTH }).expect(409);

      const body = dataOf<WinnersBody>(
        await get(`/api/v1/leaders/winners?month=${PAST_MONTH}`, token).expect(200),
      );
      expect(body.winners).toHaveLength(1);
    });

    it('422 на незавершившийся месяц', async () => {
      const now = new Date();
      const current = `${String(now.getUTCFullYear())}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

      await post('/api/v1/leaders/winners', await closer(), { month: current }).expect(422);
    });

    it('422 на месяц без единой финализированной недели', async () => {
      studentWithSums([100], { lastName: 'Алиев', month: PREVIOUS_MONTH });

      await post('/api/v1/leaders/winners', await closer(), { month: PAST_MONTH }).expect(422);
    });

    it('400 на негодное тело — и месяц остаётся незакрытым', async () => {
      const token = await closer();
      studentWithSums([100], { lastName: 'Алиев' });

      for (const body of [
        {},
        { month: '2026-13' },
        { month: '2026-6' },
        { month: PAST_MONTH, places: 0 },
        { month: PAST_MONTH, places: 99 },
        { month: PAST_MONTH, extra: 'лишнее' },
      ]) {
        await post('/api/v1/leaders/winners', token, body).expect(400);
      }

      expect(await store.countWinners(new Date(`${PAST_MONTH}-01T00:00:00.000Z`))).toBe(0);
    });
  });

  describe('Победители месяца — просмотр (ТЗ 5.13)', () => {
    it('без month отдаёт последний закрытый месяц', async () => {
      studentWithSums([100], { lastName: 'Майский', month: PREVIOUS_MONTH });
      studentWithSums([60], { lastName: 'Июньский', month: PAST_MONTH });
      const token = await closer();

      await post('/api/v1/leaders/winners', token, { month: PREVIOUS_MONTH }).expect(201);
      await post('/api/v1/leaders/winners', token, { month: PAST_MONTH }).expect(201);

      const body = dataOf<WinnersBody>(await get('/api/v1/leaders/winners', token).expect(200));

      expect(body.month).toBe(PAST_MONTH);
    });

    it('без единого закрытого месяца отдаёт пустой снимок, а не 404', async () => {
      const body = dataOf<WinnersBody>(
        await get('/api/v1/leaders/winners', await viewer()).expect(200),
      );

      expect(body).toEqual({
        month: null,
        closed: false,
        closedAt: null,
        closedBy: null,
        winners: [],
      });
    });

    it('незакрытый месяц — closed: false и пустой список', async () => {
      const body = dataOf<WinnersBody>(
        await get(`/api/v1/leaders/winners?month=${PAST_MONTH}`, await viewer()).expect(200),
      );

      expect(body).toMatchObject({ month: PAST_MONTH, closed: false, winners: [] });
    });

    it('400 на негодный месяц в запросе', async () => {
      await get('/api/v1/leaders/winners?month=2026-13', await viewer()).expect(400);
      await get('/api/v1/leaders/winners?month=июнь', await viewer()).expect(400);
    });
  });

  describe('Снятие снимка месяца', () => {
    it('снял снимок → месяц можно закрыть заново', async () => {
      studentWithSums([100], { lastName: 'Алиев' });
      const token = await closer();

      await post('/api/v1/leaders/winners', token, { month: PAST_MONTH }).expect(201);
      await post('/api/v1/leaders/winners', token, { month: PAST_MONTH }).expect(409);

      const removed = dataOf<{ month: string; removed: number }>(
        await del(`/api/v1/leaders/winners/${PAST_MONTH}`, token).expect(200),
      );
      expect(removed).toEqual({ month: PAST_MONTH, removed: 1 });

      await post('/api/v1/leaders/winners', token, { month: PAST_MONTH }).expect(201);
    });

    it('404 на снятие незакрытого месяца', async () => {
      await del(`/api/v1/leaders/winners/${PAST_MONTH}`, await closer()).expect(404);
    });

    it('снятие одного месяца не трогает соседний', async () => {
      studentWithSums([100], { lastName: 'Майский', month: PREVIOUS_MONTH });
      studentWithSums([60], { lastName: 'Июньский', month: PAST_MONTH });
      const token = await closer();

      await post('/api/v1/leaders/winners', token, { month: PREVIOUS_MONTH }).expect(201);
      await post('/api/v1/leaders/winners', token, { month: PAST_MONTH }).expect(201);
      await del(`/api/v1/leaders/winners/${PAST_MONTH}`, token).expect(200);

      const body = dataOf<WinnersBody>(
        await get(`/api/v1/leaders/winners?month=${PREVIOUS_MONTH}`, token).expect(200),
      );
      expect(body.closed).toBe(true);
    });

    it('400 на негодный месяц в пути', async () => {
      await del('/api/v1/leaders/winners/2026-13', await closer()).expect(400);
    });
  });

  it('OpenAPI описывает рейтинг и снимок месяца', () => {
    const document = buildOpenApiDocument(app);

    expect(Object.keys(document.paths?.['/api/v1/leaders'] ?? {})).toStrictEqual(['get']);
    // У снимка нет правки: ошибочный месяц снимается и закрывается заново.
    expect(Object.keys(document.paths?.['/api/v1/leaders/winners'] ?? {}).sort()).toStrictEqual([
      'get',
      'post',
    ]);
    expect(Object.keys(document.paths?.['/api/v1/leaders/winners/{month}'] ?? {})).toStrictEqual([
      'delete',
    ]);

    const closeOperation = document.paths?.['/api/v1/leaders/winners']?.post;
    expect(Object.keys(closeOperation?.responses ?? {})).toContain('201');
    expect(Object.keys(closeOperation?.responses ?? {})).not.toContain('200');
  });
});
