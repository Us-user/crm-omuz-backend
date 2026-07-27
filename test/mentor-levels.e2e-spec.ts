import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountType, DirectoryStatus, Prisma } from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, SortOrder, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { MentorLevelSortField } from 'src/mentor-levels/dto';
import { MentorLevelsModule } from 'src/mentor-levels/mentor-levels.module';
import type {
  LevelCandidate,
  MentorLevelHistoryListParams,
  MentorLevelHistoryRow,
  MentorLevelListParams,
  MentorLevelRow,
  MentorLevelUpdateInput,
  MentorLevelWriteInput,
} from 'src/mentor-levels/mentor-levels.repository';
import { MentorLevelsRepository } from 'src/mentor-levels/mentor-levels.repository';
import { PhoneModule } from 'src/phone/phone.module';
import { RbacModule } from 'src/rbac/rbac.module';
import { RbacRepository } from 'src/rbac/rbac.repository';
import { buildOpenApiDocument } from 'src/swagger';

/** `{ data }` ответа с ожидаемым типом — тела supertest типизированы как `any`. */
const dataOf = <T>(response: { body: unknown }): T => (response.body as { data: T }).data;
const metaOf = (response: { body: unknown }): { total: number; page: number; limit: number } =>
  (response.body as { meta: { total: number; page: number; limit: number } }).meta;

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

interface StoredEmployee {
  id: string;
  firstName: string;
  lastName: string;
}

/** Строка истории в хранилище: ссылка на ступень, а не копия её ставки. */
interface StoredHistory {
  id: string;
  employeeId: string;
  levelId: string;
  month: Date;
  createdAt: Date;
}

/**
 * Уровни ментора в памяти: справочник ступеней, сотрудники и помесячная история.
 *
 * Одно хранилище на всё сразу не для удобства: правила модуля связывают их между
 * собой. Простановка уровня смотрит в справочник (существует ли ступень и не
 * выведена ли она), удаление ступени упирается в историю, а ставка в ответе
 * истории берётся из справочника — то есть правка ставки обязана быть видна
 * во всех проставленных месяцах. Несогласованные заглушки проверяли бы
 * не то поведение, которое даёт БД.
 */
class InMemoryMentorLevelsStore {
  readonly levels = new Map<string, MentorLevelRow>();
  readonly employees = new Map<string, StoredEmployee>();
  readonly history = new Map<string, StoredHistory>();

  addEmployee(lastName = 'Раҳимов'): StoredEmployee {
    const employee = { id: randomUUID(), firstName: 'Фаррух', lastName };
    this.employees.set(employee.id, employee);

    return employee;
  }

  addLevel(overrides: Partial<MentorLevelRow> = {}): MentorLevelRow {
    const level: MentorLevelRow = {
      id: randomUUID(),
      name: `Уровень ${String(this.levels.size + 1)}`,
      description: null,
      hourlyRate: new Prisma.Decimal('30.00'),
      status: DirectoryStatus.ACTIVE,
      createdAt: new Date(Date.now() + this.levels.size),
      _count: { history: 0 },
      ...overrides,
    };
    this.levels.set(level.id, level);

    return level;
  }

  /** Ключ записи — естественная пара «сотрудник + месяц», как уникальный индекс в БД. */
  private key(employeeId: string, month: Date): string {
    return `${employeeId}:${month.toISOString()}`;
  }

  private historyCountOf(levelId: string): number {
    return [...this.history.values()].filter((row) => row.levelId === levelId).length;
  }

  /** Счётчик считается на выдаче — как `_count` у Prisma, а не хранится отдельно. */
  private levelRow(id: string): MentorLevelRow | null {
    const level = this.levels.get(id);

    return level ? { ...level, _count: { history: this.historyCountOf(id) } } : null;
  }

  private historyRow(stored: StoredHistory): MentorLevelHistoryRow {
    const level = this.levels.get(stored.levelId)!;

    return {
      id: stored.id,
      employeeId: stored.employeeId,
      month: stored.month,
      createdAt: stored.createdAt,
      level: {
        id: level.id,
        name: level.name,
        hourlyRate: level.hourlyRate,
        status: level.status,
      },
    };
  }

  // ─── Справочник ───

  findMany(params: MentorLevelListParams): Promise<{ rows: MentorLevelRow[]; total: number }> {
    const search = params.search?.toLowerCase();

    const matched = [...this.levels.keys()]
      .map((id) => this.levelRow(id)!)
      .filter((row) => params.status === undefined || row.status === params.status)
      .filter(
        (row) =>
          search === undefined ||
          row.name.toLowerCase().includes(search) ||
          (row.description?.toLowerCase().includes(search) ?? false),
      )
      .sort((a, b) => {
        const asc =
          params.sort === MentorLevelSortField.Name
            ? a.name.localeCompare(b.name)
            : params.sort === MentorLevelSortField.CreatedAt
              ? a.createdAt.getTime() - b.createdAt.getTime()
              : Number(a.hourlyRate) - Number(b.hourlyRate);

        return params.order === SortOrder.Asc ? asc : -asc;
      });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findById(id: string): Promise<MentorLevelRow | null> {
    return Promise.resolve(this.levelRow(id));
  }

  findByName(name: string): Promise<{ id: string; name: string } | null> {
    const found = [...this.levels.values()].find(
      (row) => row.name.toLowerCase() === name.toLowerCase(),
    );

    return Promise.resolve(found ? { id: found.id, name: found.name } : null);
  }

  create(input: MentorLevelWriteInput): Promise<MentorLevelRow> {
    return Promise.resolve(
      this.addLevel({
        name: input.name,
        description: input.description,
        hourlyRate: new Prisma.Decimal(input.hourlyRate),
        status: input.status ?? DirectoryStatus.ACTIVE,
      }),
    );
  }

  update(id: string, input: MentorLevelUpdateInput): Promise<MentorLevelRow> {
    const current = this.levels.get(id)!;

    // `undefined` Prisma пропускает — колонка остаётся прежней.
    this.levels.set(id, {
      ...current,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.hourlyRate === undefined
        ? {}
        : { hourlyRate: new Prisma.Decimal(input.hourlyRate) }),
    });

    return Promise.resolve(this.levelRow(id)!);
  }

  delete(id: string): Promise<void> {
    this.levels.delete(id);

    return Promise.resolve();
  }

  // ─── История по месяцам ───

  findHistory(
    params: MentorLevelHistoryListParams,
  ): Promise<{ rows: MentorLevelHistoryRow[]; total: number }> {
    const matched = [...this.history.values()]
      .filter((row) => row.employeeId === params.employeeId)
      .filter((row) => params.levelId === undefined || row.levelId === params.levelId)
      .filter((row) => params.from === undefined || row.month.getTime() >= params.from.getTime())
      .filter((row) => params.to === undefined || row.month.getTime() <= params.to.getTime())
      .sort((a, b) => {
        const asc = a.month.getTime() - b.month.getTime();

        return params.order === SortOrder.Asc ? asc : -asc;
      })
      .map((row) => this.historyRow(row));

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findHistoryEntry(employeeId: string, month: Date): Promise<MentorLevelHistoryRow | null> {
    const stored = this.history.get(this.key(employeeId, month));

    return Promise.resolve(stored ? this.historyRow(stored) : null);
  }

  setHistoryEntry(
    employeeId: string,
    month: Date,
    levelId: string,
  ): Promise<MentorLevelHistoryRow> {
    const key = this.key(employeeId, month);
    const current = this.history.get(key);
    // `upsert` по уникальному `(employeeId, month)`: вторая строка не заводится.
    const stored: StoredHistory = current
      ? { ...current, levelId }
      : { id: randomUUID(), employeeId, levelId, month, createdAt: new Date() };

    this.history.set(key, stored);

    return Promise.resolve(this.historyRow(stored));
  }

  deleteHistoryEntry(employeeId: string, month: Date): Promise<void> {
    this.history.delete(this.key(employeeId, month));

    return Promise.resolve();
  }

  // ─── Ссылки ───

  findEmployee(id: string): Promise<StoredEmployee | null> {
    return Promise.resolve(this.employees.get(id) ?? null);
  }

  findLevel(id: string): Promise<LevelCandidate | null> {
    const level = this.levels.get(id);

    return Promise.resolve(level ? { id: level.id, name: level.name, status: level.status } : null);
  }
}

interface LevelBody {
  id: string;
  name: string;
  description: string | null;
  hourlyRate: number;
  status: DirectoryStatus;
  historyCount: number;
}

interface HistoryBody {
  id: string;
  employeeId: string;
  month: string;
  level: { id: string; name: string; hourlyRate: number; status: DirectoryStatus };
}

const VIEWS = 'Permission.MentorLevels.Views';
const CREATE = 'Permission.MentorLevels.Create';
const UPDATE = 'Permission.MentorLevels.Update';
const DELETE = 'Permission.MentorLevels.Delete';
const MENTORS_VIEWS = 'Permission.Mentors.Views';
const MANAGE_LEVELS = 'Permission.Mentors.ManageLevels';
const ALL = [VIEWS, CREATE, UPDATE, DELETE, MENTORS_VIEWS, MANAGE_LEVELS];

describe('Уровни ментора (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryMentorLevelsStore;
  let rbac: InMemoryRbacRepository;
  let tokens: TokenService;

  beforeEach(async () => {
    store = new InMemoryMentorLevelsStore();
    rbac = new InMemoryRbacRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        PhoneModule,
        AuthModule,
        RbacModule,
        MentorLevelsModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
      ],
    })
      // AuthModule нужен целиком: он приносит глобальный `JwtAuthGuard`.
      .overrideProvider(AuthRepository)
      .useValue({})
      .overrideProvider(MentorLevelsRepository)
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

  const tokenWith = async (codes: string[]): Promise<string> => {
    const accountId = randomUUID();
    rbac.grant(accountId, codes);
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
  const put = (url: string, token: string, payload: object) =>
    server().put(url).set('Authorization', `Bearer ${token}`).send(payload);
  const del = (url: string, token: string) =>
    server().delete(url).set('Authorization', `Bearer ${token}`);

  // ───────────────────────────── Доступ ─────────────────────────────

  describe('Доступ', () => {
    it('401 без токена на справочнике и на истории', async () => {
      const employee = store.addEmployee();

      await server().get('/api/v1/mentor-levels').expect(401);
      await server().get(`/api/v1/employees/${employee.id}/mentor-levels`).expect(401);
    });

    it('403 студенту: ставки центра — не то, что видит студент', async () => {
      const token = await studentToken();
      const employee = store.addEmployee();

      await get('/api/v1/mentor-levels', token).expect(403);
      await get(`/api/v1/employees/${employee.id}/mentor-levels`, token).expect(403);
    });

    it('403 сотруднику без прав', async () => {
      const token = await tokenWith([]);

      await get('/api/v1/mentor-levels', token).expect(403);
    });

    it('право на просмотр справочника не даёт создавать, а на создание — удалять', async () => {
      const level = store.addLevel();

      await post('/api/v1/mentor-levels', await tokenWith([VIEWS]), {
        name: 'Junior',
        hourlyRate: 10,
      }).expect(403);
      await del(`/api/v1/mentor-levels/${level.id}`, await tokenWith([VIEWS, CREATE])).expect(403);
    });

    it('право на справочник историю не открывает, и наоборот', async () => {
      const employee = store.addEmployee();

      await get(`/api/v1/employees/${employee.id}/mentor-levels`, await tokenWith([VIEWS])).expect(
        403,
      );
      await get('/api/v1/mentor-levels', await tokenWith([MENTORS_VIEWS])).expect(403);
    });

    it('право на просмотр менторов не даёт двигать ступени', async () => {
      const employee = store.addEmployee();
      const level = store.addLevel();

      await put(
        `/api/v1/employees/${employee.id}/mentor-levels`,
        await tokenWith([MENTORS_VIEWS]),
        { month: '2026-09', levelId: level.id },
      ).expect(403);
    });

    it('право на карточку сотрудника уровнями не управляет', async () => {
      const employee = store.addEmployee();
      const level = store.addLevel();

      await put(
        `/api/v1/employees/${employee.id}/mentor-levels`,
        await tokenWith(['Permission.Employees.Update']),
        { month: '2026-09', levelId: level.id },
      ).expect(403);
    });
  });

  // ─────────────────────── Справочник ступеней ───────────────────────

  describe('Справочник уровней (ТЗ 5.14)', () => {
    it('создаёт ступень со ставкой числом и отдаёт 201', async () => {
      const token = await tokenWith(ALL);

      const response = await post('/api/v1/mentor-levels', token, {
        name: 'Senior mentor',
        description: 'Ведёт группы',
        hourlyRate: 45.5,
      }).expect(201);

      const level = dataOf<LevelBody>(response);
      expect(level).toMatchObject({
        name: 'Senior mentor',
        description: 'Ведёт группы',
        hourlyRate: 45.5,
        status: DirectoryStatus.ACTIVE,
        historyCount: 0,
      });
      expect(typeof level.hourlyRate).toBe('number');
    });

    it('409 на тёзку без учёта регистра — ступень не создана', async () => {
      const token = await tokenWith(ALL);
      store.addLevel({ name: 'Senior mentor' });

      await post('/api/v1/mentor-levels', token, {
        name: 'senior mentor',
        hourlyRate: 45,
      }).expect(409);
      expect(store.levels.size).toBe(1);
    });

    it.each([
      ['ставка с тремя знаками', { name: 'Junior', hourlyRate: 10.555 }],
      ['отрицательная ставка', { name: 'Junior', hourlyRate: -1 }],
      ['ставка строкой', { name: 'Junior', hourlyRate: '10' }],
      ['название в один символ', { name: 'J', hourlyRate: 10 }],
      ['лишнее поле', { name: 'Junior', hourlyRate: 10, currency: 'TJS' }],
      ['без ставки', { name: 'Junior' }],
    ])('400 на %s', async (_case, payload) => {
      await post('/api/v1/mentor-levels', await tokenWith(ALL), payload).expect(400);
    });

    it('список отдаёт `{ data, meta }` и лестницу по возрастанию ставки', async () => {
      const token = await tokenWith(ALL);
      store.addLevel({ name: 'Senior', hourlyRate: new Prisma.Decimal('45.00') });
      store.addLevel({ name: 'Junior', hourlyRate: new Prisma.Decimal('20.00') });
      store.addLevel({ name: 'Middle', hourlyRate: new Prisma.Decimal('30.00') });

      const response = await get('/api/v1/mentor-levels', token).expect(200);

      expect(dataOf<LevelBody[]>(response).map((row) => row.name)).toEqual([
        'Junior',
        'Middle',
        'Senior',
      ]);
      expect(metaOf(response)).toMatchObject({ total: 3, page: 1, limit: 20 });
    });

    it('фильтр по статусу и поиск по названию', async () => {
      const token = await tokenWith(ALL);
      store.addLevel({ name: 'Senior mentor' });
      store.addLevel({ name: 'Старый уровень', status: DirectoryStatus.INACTIVE });

      const active = await get('/api/v1/mentor-levels?status=ACTIVE', token).expect(200);
      expect(dataOf<LevelBody[]>(active)).toHaveLength(1);

      const found = await get('/api/v1/mentor-levels?search=старый', token).expect(200);
      expect(dataOf<LevelBody[]>(found)[0]?.name).toBe('Старый уровень');
    });

    it('400 на неизвестное поле сортировки', async () => {
      await get('/api/v1/mentor-levels?sort=rate', await tokenWith(ALL)).expect(400);
    });

    it('правит ставку, не трогая непереданное описание', async () => {
      const token = await tokenWith(ALL);
      const level = store.addLevel({ name: 'Senior', description: 'Наставник' });

      const response = await put(`/api/v1/mentor-levels/${level.id}`, token, {
        hourlyRate: 60,
      }).expect(200);

      expect(dataOf<LevelBody>(response)).toMatchObject({
        hourlyRate: 60,
        description: 'Наставник',
      });
    });

    it('пустая строка очищает описание', async () => {
      const token = await tokenWith(ALL);
      const level = store.addLevel({ description: 'Наставник' });

      const response = await put(`/api/v1/mentor-levels/${level.id}`, token, {
        description: '',
      }).expect(200);

      expect(dataOf<LevelBody>(response).description).toBeNull();
    });

    it('удаляет неиспользованную ступень и 404 на повтор', async () => {
      const token = await tokenWith(ALL);
      const level = store.addLevel({ name: 'Ненужный' });

      const response = await del(`/api/v1/mentor-levels/${level.id}`, token).expect(200);
      expect(dataOf<{ name: string }>(response).name).toBe('Ненужный');

      await del(`/api/v1/mentor-levels/${level.id}`, token).expect(404);
    });

    it('404/400 на путь карточки', async () => {
      const token = await tokenWith(ALL);

      await get(`/api/v1/mentor-levels/${randomUUID()}`, token).expect(404);
      await get('/api/v1/mentor-levels/не-uuid', token).expect(400);
    });
  });

  // ───────────────────── История сотрудника по месяцам ─────────────────────

  describe('Уровень по месяцам (ТЗ 5.14)', () => {
    it('проставляет уровень на месяц и отдаёт ставку рядом с ним', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();
      const level = store.addLevel({
        name: 'Senior mentor',
        hourlyRate: new Prisma.Decimal('45.50'),
      });

      const response = await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
        month: '2026-09',
        levelId: level.id,
      }).expect(200);

      expect(dataOf<HistoryBody>(response)).toMatchObject({
        employeeId: employee.id,
        month: '2026-09',
        level: { id: level.id, name: 'Senior mentor', hourlyRate: 45.5 },
      });
    });

    it('повторная простановка меняет ступень месяца, а не заводит вторую строку', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();
      const junior = store.addLevel({ name: 'Junior', hourlyRate: new Prisma.Decimal('20.00') });
      const senior = store.addLevel({ name: 'Senior', hourlyRate: new Prisma.Decimal('45.00') });

      await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
        month: '2026-09',
        levelId: junior.id,
      }).expect(200);
      await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
        month: '2026-09',
        levelId: senior.id,
      }).expect(200);

      const list = await get(`/api/v1/employees/${employee.id}/mentor-levels`, token).expect(200);
      expect(dataOf<HistoryBody[]>(list)).toHaveLength(1);
      expect(dataOf<HistoryBody[]>(list)[0]?.level.name).toBe('Senior');
      expect(store.history.size).toBe(1);
    });

    it('повышение в октябре не трогает сентябрь — ради этого история и помесячная', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();
      const junior = store.addLevel({ name: 'Junior', hourlyRate: new Prisma.Decimal('20.00') });
      const senior = store.addLevel({ name: 'Senior', hourlyRate: new Prisma.Decimal('45.00') });

      await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
        month: '2026-09',
        levelId: junior.id,
      }).expect(200);
      await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
        month: '2026-10',
        levelId: senior.id,
      }).expect(200);

      const list = await get(`/api/v1/employees/${employee.id}/mentor-levels`, token).expect(200);
      expect(dataOf<HistoryBody[]>(list).map((row) => [row.month, row.level.hourlyRate])).toEqual([
        ['2026-10', 45],
        ['2026-09', 20],
      ]);
    });

    it('новая ставка справочника видна во всех проставленных месяцах', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();
      const level = store.addLevel({ name: 'Senior', hourlyRate: new Prisma.Decimal('45.00') });

      await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
        month: '2026-09',
        levelId: level.id,
      }).expect(200);
      await put(`/api/v1/mentor-levels/${level.id}`, token, { hourlyRate: 50 }).expect(200);

      const list = await get(`/api/v1/employees/${employee.id}/mentor-levels`, token).expect(200);
      expect(dataOf<HistoryBody[]>(list)[0]?.level.hourlyRate).toBe(50);
    });

    it('месяц без записи в истории просто отсутствует: предыдущий сюда не тянется', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();
      const level = store.addLevel();

      await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
        month: '2026-09',
        levelId: level.id,
      }).expect(200);

      const list = await get(
        `/api/v1/employees/${employee.id}/mentor-levels?from=2026-10&to=2026-10`,
        token,
      ).expect(200);
      expect(dataOf<HistoryBody[]>(list)).toEqual([]);
      expect(metaOf(list).total).toBe(0);
    });

    it('фильтр периода включает границы', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();
      const level = store.addLevel();

      for (const month of ['2026-01', '2026-02', '2026-03', '2026-04']) {
        await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
          month,
          levelId: level.id,
        }).expect(200);
      }

      const quarter = await get(
        `/api/v1/employees/${employee.id}/mentor-levels?from=2026-02&to=2026-03&order=asc`,
        token,
      ).expect(200);
      expect(dataOf<HistoryBody[]>(quarter).map((row) => row.month)).toEqual([
        '2026-02',
        '2026-03',
      ]);
    });

    it('фильтр по ступени', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();
      const junior = store.addLevel({ name: 'Junior' });
      const senior = store.addLevel({ name: 'Senior' });

      await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
        month: '2026-09',
        levelId: junior.id,
      }).expect(200);
      await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
        month: '2026-10',
        levelId: senior.id,
      }).expect(200);

      const list = await get(
        `/api/v1/employees/${employee.id}/mentor-levels?levelId=${senior.id}`,
        token,
      ).expect(200);
      expect(dataOf<HistoryBody[]>(list).map((row) => row.month)).toEqual(['2026-10']);
    });

    it('история соседнего сотрудника в список не попадает', async () => {
      const token = await tokenWith(ALL);
      const first = store.addEmployee('Раҳимов');
      const second = store.addEmployee('Каримова');
      const level = store.addLevel();

      await put(`/api/v1/employees/${first.id}/mentor-levels`, token, {
        month: '2026-09',
        levelId: level.id,
      }).expect(200);

      const list = await get(`/api/v1/employees/${second.id}/mentor-levels`, token).expect(200);
      expect(dataOf<HistoryBody[]>(list)).toEqual([]);
    });

    it('422 на несуществующую ступень — запись не появилась', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();

      await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
        month: '2026-09',
        levelId: randomUUID(),
      }).expect(422);
      expect(store.history.size).toBe(0);
    });

    it('422 на ступень, выведенную из справочника — но уже проставленная остаётся', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();
      const level = store.addLevel({ name: 'Старый уровень' });

      await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
        month: '2026-09',
        levelId: level.id,
      }).expect(200);

      await put(`/api/v1/mentor-levels/${level.id}`, token, {
        status: DirectoryStatus.INACTIVE,
      }).expect(200);

      await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
        month: '2026-10',
        levelId: level.id,
      }).expect(422);

      const list = await get(`/api/v1/employees/${employee.id}/mentor-levels`, token).expect(200);
      expect(dataOf<HistoryBody[]>(list).map((row) => row.month)).toEqual(['2026-09']);
    });

    it('уровень ставится сотруднику без позиции «Mentor»', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();
      const level = store.addLevel();

      await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
        month: '2026-09',
        levelId: level.id,
      }).expect(200);
    });

    it.each([
      ['месяц с днём', '2026-09-01'],
      ['месяц одной цифрой', '2026-9'],
      ['тринадцатый месяц', '2026-13'],
      ['месяц словом', 'сентябрь'],
    ])('400 на %s', async (_case, month) => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();
      const level = store.addLevel();

      await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
        month,
        levelId: level.id,
      }).expect(400);
    });

    it('400 на не-UUID ступени и на лишнее поле', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();
      const level = store.addLevel();

      await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
        month: '2026-09',
        levelId: 'не-uuid',
      }).expect(400);
      await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
        month: '2026-09',
        levelId: level.id,
        hourlyRate: 100,
      }).expect(400);
    });

    it('404 на неизвестного сотрудника в списке и при простановке', async () => {
      const token = await tokenWith(ALL);
      const level = store.addLevel();
      const unknown = randomUUID();

      await get(`/api/v1/employees/${unknown}/mentor-levels`, token).expect(404);
      await put(`/api/v1/employees/${unknown}/mentor-levels`, token, {
        month: '2026-09',
        levelId: level.id,
      }).expect(404);
    });

    it('400 на не-UUID сотрудника в пути', async () => {
      await get('/api/v1/employees/не-uuid/mentor-levels', await tokenWith(ALL)).expect(400);
    });
  });

  // ─────────────────────────── Снятие уровня ───────────────────────────

  describe('Снятие уровня с месяца', () => {
    it('снимает запись, называет ступень и 404 на повтор', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();
      const level = store.addLevel({ name: 'Senior' });

      await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
        month: '2026-09',
        levelId: level.id,
      }).expect(200);

      const response = await del(
        `/api/v1/employees/${employee.id}/mentor-levels/2026-09`,
        token,
      ).expect(200);
      expect(dataOf<{ levelName: string; month: string }>(response)).toMatchObject({
        levelName: 'Senior',
        month: '2026-09',
      });

      await del(`/api/v1/employees/${employee.id}/mentor-levels/2026-09`, token).expect(404);
    });

    it('снятие одного месяца не трогает соседние', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();
      const level = store.addLevel();

      for (const month of ['2026-09', '2026-10']) {
        await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
          month,
          levelId: level.id,
        }).expect(200);
      }

      await del(`/api/v1/employees/${employee.id}/mentor-levels/2026-09`, token).expect(200);

      const list = await get(`/api/v1/employees/${employee.id}/mentor-levels`, token).expect(200);
      expect(dataOf<HistoryBody[]>(list).map((row) => row.month)).toEqual(['2026-10']);
    });

    it('400 на негодный месяц в пути', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();

      await del(`/api/v1/employees/${employee.id}/mentor-levels/2026-13`, token).expect(400);
    });

    it('снятие требует права на ступени, а не просмотра менторов', async () => {
      const employee = store.addEmployee();

      await del(
        `/api/v1/employees/${employee.id}/mentor-levels/2026-09`,
        await tokenWith([MENTORS_VIEWS]),
      ).expect(403);
    });
  });

  // ──────────────────── Связь справочника и истории ────────────────────

  describe('Ступень, по которой считали зарплату', () => {
    it('409 на удаление проставленной ступени — с числом месяцев и ступень на месте', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();
      const level = store.addLevel({ name: 'Senior' });

      for (const month of ['2026-09', '2026-10']) {
        await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
          month,
          levelId: level.id,
        }).expect(200);
      }

      const response = await del(`/api/v1/mentor-levels/${level.id}`, token).expect(409);
      expect((response.body as { error: { message: string } }).error.message).toContain('2');
      expect(store.levels.has(level.id)).toBe(true);
    });

    it('освободившаяся ступень удаляется', async () => {
      const token = await tokenWith(ALL);
      const employee = store.addEmployee();
      const level = store.addLevel();

      await put(`/api/v1/employees/${employee.id}/mentor-levels`, token, {
        month: '2026-09',
        levelId: level.id,
      }).expect(200);
      await del(`/api/v1/mentor-levels/${level.id}`, token).expect(409);

      await del(`/api/v1/employees/${employee.id}/mentor-levels/2026-09`, token).expect(200);
      await del(`/api/v1/mentor-levels/${level.id}`, token).expect(200);
    });

    it('счётчик месяцев виден в карточке ступени', async () => {
      const token = await tokenWith(ALL);
      const first = store.addEmployee('Раҳимов');
      const second = store.addEmployee('Каримова');
      const level = store.addLevel();

      await put(`/api/v1/employees/${first.id}/mentor-levels`, token, {
        month: '2026-09',
        levelId: level.id,
      }).expect(200);
      await put(`/api/v1/employees/${second.id}/mentor-levels`, token, {
        month: '2026-09',
        levelId: level.id,
      }).expect(200);

      const response = await get(`/api/v1/mentor-levels/${level.id}`, token).expect(200);
      expect(dataOf<LevelBody>(response).historyCount).toBe(2);
    });
  });

  describe('OpenAPI', () => {
    it('три пути описаны, создание ступени отвечает 201, а простановка уровня — 200', () => {
      const document = buildOpenApiDocument(app);

      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/mentor-levels',
          '/api/v1/mentor-levels/{id}',
          '/api/v1/employees/{employeeId}/mentor-levels',
        ]),
      );

      const catalog = document.paths['/api/v1/mentor-levels'];
      expect(catalog?.get?.responses['200']).toBeDefined();
      expect(catalog?.post?.responses['201']).toBeDefined();
      expect(catalog?.post?.responses['200']).toBeUndefined();

      const history = document.paths['/api/v1/employees/{employeeId}/mentor-levels'];
      expect(history?.get?.responses['200']).toBeDefined();
      expect(history?.put?.responses['200']).toBeDefined();
      // Простановка ничего не создаёт по адресу — 201 здесь был бы неправдой.
      expect(history?.put?.responses['201']).toBeUndefined();
      expect(history?.post).toBeUndefined();
    });
  });
});
