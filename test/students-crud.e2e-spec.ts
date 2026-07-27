import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  AccountStatus,
  AccountType,
  Gender,
  GroupStudentStatus,
  StudentStatus,
} from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { PhoneModule } from 'src/phone/phone.module';
import { RbacModule } from 'src/rbac/rbac.module';
import { RbacRepository } from 'src/rbac/rbac.repository';
import type {
  StudentDeletionCheck,
  StudentListParams,
  StudentRow,
  StudentUpdateInput,
  StudentWriteInput,
} from 'src/students/students.repository';
import { StudentsRepository } from 'src/students/students.repository';
import { StudentsModule } from 'src/students/students.module';
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

interface StoredGroup {
  id: string;
  name: string;
  courseId: string;
  courseTitle: string;
}

/**
 * Студенты в памяти вместе с филиалами, группами и членствами: карточка отдаёт
 * филиал и действующие группы, фильтры «Group»/«Course» ищут по членствам,
 * а удаление смотрит на их число. Несогласованные заглушки проверяли бы
 * не то поведение, которое даёт БД.
 */
class InMemoryStudentsStore {
  readonly students = new Map<string, StudentRow>();
  readonly branches = new Map<string, { id: string; name: string }>();
  readonly groups = new Map<string, StoredGroup>();

  /** Членства: `studentId` → список групп со статусом участия. */
  private readonly memberships = new Map<
    string,
    { group: StoredGroup; status: GroupStudentStatus }[]
  >();

  /** Профили, переведённые в сотрудники (`Employee.formerStudentId`). */
  private readonly promoted = new Set<string>();

  addBranch(name: string): { id: string; name: string } {
    const branch = { id: randomUUID(), name };
    this.branches.set(branch.id, branch);

    return branch;
  }

  addGroup(name: string, courseTitle: string, courseId = randomUUID()): StoredGroup {
    const group: StoredGroup = { id: randomUUID(), name, courseId, courseTitle };
    this.groups.set(group.id, group);

    return group;
  }

  addStudent(overrides: Partial<StudentRow> = {}): StudentRow {
    const index = this.students.size + 1;
    const student: StudentRow = {
      id: randomUUID(),
      firstName: 'Нигина',
      lastName: `Каримова-${String(index)}`,
      phone: `+99290123456${String(index)}`,
      birthDate: null,
      gender: null,
      address: null,
      email: null,
      parents: [],
      extraPhones: [],
      telegram: null,
      photoUrl: null,
      notes: null,
      status: StudentStatus.ACTIVE,
      createdAt: new Date('2026-07-27T10:15:00.000Z'),
      branch: null,
      account: null,
      groups: [],
      _count: { groups: 0 },
      ...overrides,
    };
    this.students.set(student.id, student);

    return student;
  }

  enroll(
    studentId: string,
    group: StoredGroup,
    status: GroupStudentStatus = GroupStudentStatus.ACTIVE,
  ): void {
    const memberships = this.memberships.get(studentId) ?? [];
    memberships.push({ group, status });
    this.memberships.set(studentId, memberships);
    this.refresh(studentId);
  }

  promote(studentId: string): void {
    this.promoted.add(studentId);
  }

  // ─── StudentsRepository ───

  findMany(params: StudentListParams): Promise<{ rows: StudentRow[]; total: number }> {
    const search = params.search?.toLowerCase();

    const matched = [...this.students.values()]
      .filter((student) => params.status === undefined || student.status === params.status)
      .filter((student) => params.branchId === undefined || student.branch?.id === params.branchId)
      .filter(
        (student) =>
          params.hasAccount === undefined || (student.account !== null) === params.hasAccount,
      )
      // Фильтры «Group» и «Course» смотрят только на действующие членства —
      // они и лежат в `groups` карточки.
      .filter(
        (student) =>
          params.groupId === undefined ||
          student.groups.some(({ group }) => group.id === params.groupId),
      )
      .filter(
        (student) =>
          params.courseId === undefined ||
          student.groups.some(({ group }) => group.courseId === params.courseId),
      )
      .filter(
        (student) =>
          search === undefined ||
          [student.firstName, student.lastName, student.phone, student.email ?? ''].some((field) =>
            field.toLowerCase().includes(search),
          ),
      );

    const sort: string = params.sort;
    const order: string = params.order;

    matched.sort((a, b) => {
      const asc =
        sort === 'createdAt'
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName);

      return order === 'asc' ? asc : -asc;
    });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findById(id: string): Promise<StudentRow | null> {
    return Promise.resolve(this.students.get(id) ?? null);
  }

  findByPhone(phone: string): Promise<{ id: string; firstName: string; lastName: string } | null> {
    const found = [...this.students.values()].find((student) => student.phone === phone);

    return Promise.resolve(
      found ? { id: found.id, firstName: found.firstName, lastName: found.lastName } : null,
    );
  }

  findBranch(id: string): Promise<{ id: string } | null> {
    const branch = this.branches.get(id);

    return Promise.resolve(branch ? { id: branch.id } : null);
  }

  findForDeletion(id: string): Promise<StudentDeletionCheck | null> {
    const student = this.students.get(id);
    if (!student) return Promise.resolve(null);

    return Promise.resolve({
      id: student.id,
      firstName: student.firstName,
      lastName: student.lastName,
      accountId: student.account?.id ?? null,
      promotedEmployee: this.promoted.has(id) ? { id: randomUUID() } : null,
      _count: {
        groups: student._count.groups,
        journalEntries: 0,
        coinTransactions: 0,
        monthlyWins: 0,
        graduations: 0,
      },
    });
  }

  create(input: StudentWriteInput): Promise<StudentRow> {
    const student = this.addStudent({
      ...input,
      status: input.status ?? StudentStatus.ACTIVE,
      branch: input.branchId === null ? null : (this.branches.get(input.branchId) ?? null),
    });

    return Promise.resolve(student);
  }

  update(id: string, input: StudentUpdateInput): Promise<StudentRow> {
    const student = this.students.get(id);
    if (!student) throw new Error('Студента нет: тест построен неверно');

    // `undefined` Prisma пропускает — колонка остаётся прежней.
    for (const [field, value] of Object.entries(input)) {
      if (value === undefined) continue;
      if (field === 'branchId') {
        student.branch = value === null ? null : (this.branches.get(value as string) ?? null);
        continue;
      }
      Object.assign(student, { [field]: value });
    }

    return Promise.resolve(student);
  }

  delete(id: string, accountId: string | null): Promise<void> {
    const student = this.students.get(id);
    // Аккаунт уходит вместе с профилем одной транзакцией (ТЗ 3.1).
    if (student && accountId !== null) student.account = null;
    this.students.delete(id);
    this.memberships.delete(id);

    return Promise.resolve();
  }

  /** Пересчитывает то, что в БД отдают вложенный `select` и `_count`. */
  private refresh(studentId: string): void {
    const student = this.students.get(studentId);
    const memberships = this.memberships.get(studentId) ?? [];
    if (!student) return;

    student.groups = memberships
      .filter(({ status }) => status === GroupStudentStatus.ACTIVE)
      .map(({ group }) => ({
        group: {
          id: group.id,
          name: group.name,
          courseId: group.courseId,
          course: { title: group.courseTitle },
        },
      }));
    student._count = { groups: memberships.length };
  }
}

interface StudentBody {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  birthDate: string | null;
  gender: Gender | null;
  email: string | null;
  parents: { id: string; firstName: string | null; phone: string; relation: string | null }[];
  extraPhones: string[];
  telegram: string | null;
  notes: string | null;
  address: string | null;
  branch: { id: string; name: string } | null;
  account: { id: string; phone: string } | null;
  status: StudentStatus;
  activeGroups: { id: string; name: string; courseTitle: string }[];
  groupsCount: number;
}

describe('Студенты: CRUD (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryStudentsStore;
  let rbac: InMemoryRbacRepository;
  let tokens: TokenService;

  beforeEach(async () => {
    store = new InMemoryStudentsStore();
    rbac = new InMemoryRbacRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        PhoneModule,
        AuthModule,
        RbacModule,
        StudentsModule,
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
      .overrideProvider(StudentsRepository)
      .useValue({
        findMany: (params: StudentListParams) => store.findMany(params),
        findById: (id: string) => store.findById(id),
        findByPhone: (phone: string) => store.findByPhone(phone),
        findBranch: (id: string) => store.findBranch(id),
        findForDeletion: (id: string) => store.findForDeletion(id),
        // Журнала в этом наборе нет: балла и короны у студентов не возникает.
        // Их проверяет `performance.e2e-spec.ts`, где есть недели и их итоги.
        aggregateScores: () => Promise.resolve([]),
        findTopAverage: () => Promise.resolve(null),
        create: (input: StudentWriteInput) => store.create(input),
        update: (id: string, input: StudentUpdateInput) => store.update(id, input),
        delete: (id: string, accountId: string | null) => store.delete(id, accountId),
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

  /** Сотрудник с перечисленными правами — токен выпускается напрямую. */
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

  const get = (url: string, token: string) =>
    request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);

  const send = (
    method: 'post' | 'put' | 'delete',
    url: string,
    token: string,
    body: Record<string, unknown> = {},
  ) => request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`).send(body);

  const NEW_STUDENT = { firstName: 'Нигина', lastName: 'Каримова', phone: '+992901234567' };

  describe('Доступ', () => {
    it('без токена — 401', async () => {
      await request(app.getHttpServer()).get('/api/v1/students').expect(401);
    });

    it('студент список студентов не видит — 403 (ТЗ 3.2)', async () => {
      await get('/api/v1/students', await studentToken()).expect(403);
    });

    it('сотрудник без прав — 403', async () => {
      await get('/api/v1/students', await actor()).expect(403);
    });

    it('право на просмотр не даёт права на создание', async () => {
      const token = await actor('Permission.Students.Views');

      await get('/api/v1/students', token).expect(200);
      await send('post', '/api/v1/students', token, NEW_STUDENT).expect(403);
    });

    it('право на создание не даёт права на удаление', async () => {
      const student = store.addStudent();

      await send(
        'delete',
        `/api/v1/students/${student.id}`,
        await actor('Permission.Students.Create'),
      ).expect(403);
    });

    it('право на группы карточку студента не открывает', async () => {
      const student = store.addStudent();

      await get(`/api/v1/students/${student.id}`, await actor('Permission.Groups.Views')).expect(
        403,
      );
    });
  });

  describe('Создание (ТЗ 5.3: форма карточки)', () => {
    it('заводит профиль со всеми полями формы и без аккаунта', async () => {
      const branch = store.addBranch('Sadbarg');

      const response = await send(
        'post',
        '/api/v1/students',
        await actor('Permission.Students.Create'),
        {
          firstName: 'Нигина',
          lastName: 'Каримова',
          phone: '901234567',
          birthDate: '2004-05-17',
          gender: Gender.FEMALE,
          address: 'ул. Рудаки, 105',
          email: 'Nigina@Mail.TJ',
          extraPhones: ['92 111 22 33'],
          telegram: '@nigina',
          notes: 'Записалась по рекламе',
          branchId: branch.id,
        },
      ).expect(201);

      expect(dataOf<StudentBody>(response)).toMatchObject({
        firstName: 'Нигина',
        lastName: 'Каримова',
        // Телефоны приведены к E.164, email — к нижнему регистру (ТЗ 3.1).
        phone: '+992901234567',
        extraPhones: ['+992921112233'],
        // Телефона родителя в форме ТЗ 5.3 нет: контакты ведёт /students/{id}/parents.
        parents: [],
        email: 'nigina@mail.tj',
        birthDate: '2004-05-17',
        gender: Gender.FEMALE,
        telegram: '@nigina',
        branch: { id: branch.id, name: 'Sadbarg' },
        status: StudentStatus.ACTIVE,
        // ТЗ 5.3: аккаунт опционален и выдаётся отдельным действием Invite.
        account: null,
        activeGroups: [],
        groupsCount: 0,
      });
    });

    it('409 на занятый телефон — с именем того, за кем он записан', async () => {
      store.addStudent({ phone: '+992901234567', firstName: 'Заррина', lastName: 'Сафарова' });

      const response = await send(
        'post',
        '/api/v1/students',
        await actor('Permission.Students.Create'),
        NEW_STUDENT,
      ).expect(409);

      expect((response.body as { error: { message: string } }).error.message).toContain(
        'Сафарова Заррина',
      );
      expect(store.students.size).toBe(1);
    });

    it('конфликт ловится и на номере, записанном в другом формате', async () => {
      store.addStudent({ phone: '+992901234567' });

      await send('post', '/api/v1/students', await actor('Permission.Students.Create'), {
        ...NEW_STUDENT,
        phone: '901234567',
      }).expect(409);
    });

    it('422 на несуществующий филиал — студент не создаётся', async () => {
      await send('post', '/api/v1/students', await actor('Permission.Students.Create'), {
        ...NEW_STUDENT,
        branchId: randomUUID(),
      }).expect(422);

      expect(store.students.size).toBe(0);
    });

    it('400 на неразбираемый телефон, 30 февраля, лишнее поле и длинный список номеров', async () => {
      const token = await actor('Permission.Students.Create');

      await send('post', '/api/v1/students', token, {
        ...NEW_STUDENT,
        phone: 'не телефон',
      }).expect(400);
      await send('post', '/api/v1/students', token, {
        ...NEW_STUDENT,
        birthDate: '2004-02-30',
      }).expect(400);
      await send('post', '/api/v1/students', token, {
        ...NEW_STUDENT,
        birthDate: '17.05.2004',
      }).expect(400);
      await send('post', '/api/v1/students', token, { ...NEW_STUDENT, nickname: 'ниги' }).expect(
        400,
      );
      await send('post', '/api/v1/students', token, {
        ...NEW_STUDENT,
        extraPhones: ['1', '2', '3', '4', '5', '6'],
      }).expect(400);
      await send('post', '/api/v1/students', token, { ...NEW_STUDENT, email: 'не почта' }).expect(
        400,
      );
    });

    it('телефон родителя в форме не принимается — он ведётся в /parents (ТЗ 4)', async () => {
      const token = await actor('Permission.Students.Create');

      await send('post', '/api/v1/students', token, {
        ...NEW_STUDENT,
        parentPhone: '+992907654321',
      }).expect(400);
    });
  });

  describe('Список и фильтры (ТЗ 5.3)', () => {
    /** Двое студентов: одна учится на Frontend, вторая ушла и сидит без групп. */
    const scene = () => {
      const branch = store.addBranch('Sadbarg');
      const frontend = store.addGroup('Frontend-1', 'Frontend Basic');
      const python = store.addGroup('Python-1', 'Python Start');

      const nigina = store.addStudent({ lastName: 'Каримова', branch, email: 'nigina@mail.tj' });
      const farrukh = store.addStudent({ lastName: 'Раҳимов', status: StudentStatus.NO_ACTIVE });

      store.enroll(nigina.id, frontend);
      store.enroll(farrukh.id, python, GroupStudentStatus.LEFT);

      return { branch, frontend, python, nigina, farrukh };
    };

    it('отдаёт { data, meta }, порядок по фамилии и действующие группы', async () => {
      const { frontend } = scene();

      const response = await get(
        '/api/v1/students',
        await actor('Permission.Students.Views'),
      ).expect(200);

      const body = response.body as { data: StudentBody[]; meta: { total: number } };
      expect(body.meta).toMatchObject({ total: 2, page: 1, limit: 20 });
      expect(body.data.map((student) => student.lastName)).toEqual(['Каримова', 'Раҳимов']);
      expect(body.data[0]?.activeGroups).toEqual([
        {
          id: frontend.id,
          name: 'Frontend-1',
          courseId: frontend.courseId,
          courseTitle: 'Frontend Basic',
        },
      ]);
      // Закрытое членство в список действующих не попадает, но историю держит.
      expect(body.data[1]?.activeGroups).toEqual([]);
      expect(body.data[1]?.groupsCount).toBe(1);
    });

    it('фильтр по статусу (ТЗ 5.3)', async () => {
      scene();

      const response = await get(
        `/api/v1/students?status=${StudentStatus.NO_ACTIVE}`,
        await actor('Permission.Students.Views'),
      ).expect(200);

      expect(dataOf<StudentBody[]>(response).map((s) => s.lastName)).toEqual(['Раҳимов']);
    });

    it('фильтр «Group» — только действующие членства', async () => {
      const { frontend, python } = scene();
      const token = await actor('Permission.Students.Views');

      const inFrontend = await get(`/api/v1/students?groupId=${frontend.id}`, token).expect(200);
      expect(dataOf<StudentBody[]>(inFrontend).map((s) => s.lastName)).toEqual(['Каримова']);

      // Из Python-1 студент ушёл — в её составе он больше не числится.
      const inPython = await get(`/api/v1/students?groupId=${python.id}`, token).expect(200);
      expect(dataOf<StudentBody[]>(inPython)).toEqual([]);
    });

    it('фильтр «Course»', async () => {
      const { frontend } = scene();

      const response = await get(
        `/api/v1/students?courseId=${frontend.courseId}`,
        await actor('Permission.Students.Views'),
      ).expect(200);

      expect(dataOf<StudentBody[]>(response).map((s) => s.lastName)).toEqual(['Каримова']);
    });

    it('фильтр по филиалу (ТЗ 3.3)', async () => {
      const { branch } = scene();

      const response = await get(
        `/api/v1/students?branchId=${branch.id}`,
        await actor('Permission.Students.Views'),
      ).expect(200);

      expect(dataOf<StudentBody[]>(response).map((s) => s.lastName)).toEqual(['Каримова']);
    });

    it('фильтр hasAccount=false даёт тех, кого стоит пригласить (ТЗ 5.3: Invite)', async () => {
      scene();
      const withAccount = store.addStudent({
        lastName: 'Азизова',
        account: {
          id: randomUUID(),
          phone: '+992905555555',
          email: 'aziza@mail.tj',
          status: AccountStatus.ACTIVE,
        },
      });
      const token = await actor('Permission.Students.Views');

      const invited = await get('/api/v1/students?hasAccount=true', token).expect(200);
      expect(dataOf<StudentBody[]>(invited).map((s) => s.id)).toEqual([withAccount.id]);

      const pending = await get('/api/v1/students?hasAccount=false', token).expect(200);
      expect(dataOf<StudentBody[]>(pending)).toHaveLength(2);
    });

    it('поиск по фамилии и по email', async () => {
      scene();
      const token = await actor('Permission.Students.Views');

      const byName = await get('/api/v1/students?search=каримова', token).expect(200);
      expect(dataOf<StudentBody[]>(byName)).toHaveLength(1);

      const byEmail = await get('/api/v1/students?search=NIGINA@mail', token).expect(200);
      expect(dataOf<StudentBody[]>(byEmail)).toHaveLength(1);
    });

    it('400 на неизвестное поле сортировки и на не-UUID в фильтре', async () => {
      const token = await actor('Permission.Students.Views');

      await get('/api/v1/students?sort=phone', token).expect(400);
      await get('/api/v1/students?groupId=не-uuid', token).expect(400);
    });
  });

  describe('Карточка', () => {
    it('отдаёт студента с аккаунтом, но без хеша пароля', async () => {
      const student = store.addStudent({
        account: {
          id: randomUUID(),
          phone: '+992901234567',
          email: 'nigina@mail.tj',
          status: AccountStatus.ACTIVE,
        },
      });

      const response = await get(
        `/api/v1/students/${student.id}`,
        await actor('Permission.Students.Views'),
      ).expect(200);

      expect(dataOf<StudentBody>(response).account).toMatchObject({ phone: '+992901234567' });
      expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    });

    it('404 на неизвестного, 400 на не-UUID в пути', async () => {
      const token = await actor('Permission.Students.Views');

      await get(`/api/v1/students/${randomUUID()}`, token).expect(404);
      await get('/api/v1/students/не-uuid', token).expect(400);
    });
  });

  describe('Правка (ТЗ 5.3)', () => {
    it('меняет переданное и сохраняет непереданное', async () => {
      const branch = store.addBranch('Sadbarg');
      const student = store.addStudent({ telegram: '@nigina', branch, notes: 'Заметка' });

      const response = await send(
        'put',
        `/api/v1/students/${student.id}`,
        await actor('Permission.Students.Update'),
        { lastName: 'Каримова-Сафарова' },
      ).expect(200);

      expect(dataOf<StudentBody>(response)).toMatchObject({
        lastName: 'Каримова-Сафарова',
        telegram: '@nigina',
        notes: 'Заметка',
        branch: { id: branch.id },
      });
    });

    it('пустая строка очищает поле и снимает филиал', async () => {
      const branch = store.addBranch('Sadbarg');
      const student = store.addStudent({ telegram: '@nigina', notes: 'Заметка', branch });

      const response = await send(
        'put',
        `/api/v1/students/${student.id}`,
        await actor('Permission.Students.Update'),
        { telegram: '', notes: '', branchId: '' },
      ).expect(200);

      expect(dataOf<StudentBody>(response)).toMatchObject({
        telegram: null,
        notes: null,
        branch: null,
      });
    });

    it('400 на пустой телефон: он обязателен и очистке не подлежит', async () => {
      const student = store.addStudent({ phone: '+992901234567' });

      await send(
        'put',
        `/api/v1/students/${student.id}`,
        await actor('Permission.Students.Update'),
        { phone: '' },
      ).expect(400);

      expect(store.students.get(student.id)?.phone).toBe('+992901234567');
    });

    it('свой же телефон конфликтом не считается, чужой — 409', async () => {
      const student = store.addStudent({ phone: '+992901234567' });
      const other = store.addStudent({ phone: '+992905555555' });
      const token = await actor('Permission.Students.Update');

      await send('put', `/api/v1/students/${student.id}`, token, { phone: '901234567' }).expect(
        200,
      );
      await send('put', `/api/v1/students/${student.id}`, token, {
        phone: other.phone,
      }).expect(409);
    });

    it('422 на перенос в несуществующий филиал — карточка не меняется', async () => {
      const student = store.addStudent({ lastName: 'Каримова' });

      await send(
        'put',
        `/api/v1/students/${student.id}`,
        await actor('Permission.Students.Update'),
        { lastName: 'Сафарова', branchId: randomUUID() },
      ).expect(422);

      expect(store.students.get(student.id)?.lastName).toBe('Каримова');
    });

    it('статус ставится руками (ТЗ 5.3: Active / No Active / Finished)', async () => {
      const student = store.addStudent();
      const token = await actor('Permission.Students.Update');

      for (const status of [
        StudentStatus.NO_ACTIVE,
        StudentStatus.FINISHED,
        StudentStatus.ACTIVE,
      ]) {
        const response = await send('put', `/api/v1/students/${student.id}`, token, {
          status,
        }).expect(200);

        expect(dataOf<StudentBody>(response).status).toBe(status);
      }
    });

    // «Block» по ТЗ 5.3 — это блок **входа**, то есть статус профиля и аккаунта
    // вместе. Поставленный формой, он пометил бы студента заблокированным,
    // оставив ему возможность войти.
    it('422 на «Block» через правку — для этого есть POST /students/{id}/block', async () => {
      const student = store.addStudent();

      await send(
        'put',
        `/api/v1/students/${student.id}`,
        await actor('Permission.Students.Update'),
        {
          status: StudentStatus.BLOCK,
        },
      ).expect(422);

      expect(store.students.get(student.id)?.status).toBe(StudentStatus.ACTIVE);
    });

    it('422 на снятие «Block» правкой — вход остался бы закрытым', async () => {
      const student = store.addStudent({ status: StudentStatus.BLOCK });

      await send(
        'put',
        `/api/v1/students/${student.id}`,
        await actor('Permission.Students.Update'),
        {
          status: StudentStatus.ACTIVE,
        },
      ).expect(422);

      expect(store.students.get(student.id)?.status).toBe(StudentStatus.BLOCK);
    });

    it('заблокированному правятся остальные поля', async () => {
      const student = store.addStudent({ status: StudentStatus.BLOCK });

      const response = await send(
        'put',
        `/api/v1/students/${student.id}`,
        await actor('Permission.Students.Update'),
        { notes: 'Ждёт разбора' },
      ).expect(200);

      expect(dataOf<StudentBody>(response)).toMatchObject({
        notes: 'Ждёт разбора',
        status: StudentStatus.BLOCK,
      });
    });

    it('400 на неизвестный статус', async () => {
      const student = store.addStudent();

      await send(
        'put',
        `/api/v1/students/${student.id}`,
        await actor('Permission.Students.Update'),
        { status: 'ARCHIVED' },
      ).expect(400);
    });

    it('404 на неизвестного студента', async () => {
      await send(
        'put',
        `/api/v1/students/${randomUUID()}`,
        await actor('Permission.Students.Update'),
        { lastName: 'Сафарова' },
      ).expect(404);
    });
  });

  describe('Удаление', () => {
    it('удаляет «чистый» профиль и называет удалённого', async () => {
      const student = store.addStudent({ firstName: 'Нигина', lastName: 'Каримова' });

      const response = await send(
        'delete',
        `/api/v1/students/${student.id}`,
        await actor('Permission.Students.Delete'),
      ).expect(200);

      expect(dataOf<{ fullName: string; accountDeleted: boolean }>(response)).toEqual({
        id: student.id,
        fullName: 'Каримова Нигина',
        accountDeleted: false,
      });
      expect(store.students.has(student.id)).toBe(false);
    });

    it('аккаунт удаляется вместе с профилем (ТЗ 3.1)', async () => {
      const student = store.addStudent({
        account: {
          id: randomUUID(),
          phone: '+992901234567',
          email: 'nigina@mail.tj',
          status: AccountStatus.ACTIVE,
        },
      });

      const response = await send(
        'delete',
        `/api/v1/students/${student.id}`,
        await actor('Permission.Students.Delete'),
      ).expect(200);

      expect(dataOf<{ accountDeleted: boolean }>(response).accountDeleted).toBe(true);
    });

    it('409 на студента с учебной историей — профиль остаётся', async () => {
      const group = store.addGroup('Frontend-1', 'Frontend Basic');
      const student = store.addStudent();
      store.enroll(student.id, group);

      const response = await send(
        'delete',
        `/api/v1/students/${student.id}`,
        await actor('Permission.Students.Delete'),
      ).expect(409);

      expect((response.body as { error: { message: string } }).error.message).toContain(
        'членства в группах (1)',
      );
      expect(store.students.has(student.id)).toBe(true);
    });

    it('закрытое членство держит профиль так же, как действующее (ТЗ 5.12)', async () => {
      const group = store.addGroup('Frontend-1', 'Frontend Basic');
      const student = store.addStudent();
      store.enroll(student.id, group, GroupStudentStatus.LEFT);

      await send(
        'delete',
        `/api/v1/students/${student.id}`,
        await actor('Permission.Students.Delete'),
      ).expect(409);
    });

    it('409 на переведённого в сотрудники', async () => {
      const student = store.addStudent();
      store.promote(student.id);

      const response = await send(
        'delete',
        `/api/v1/students/${student.id}`,
        await actor('Permission.Students.Delete'),
      ).expect(409);

      expect((response.body as { error: { message: string } }).error.message).toContain(
        'переведён в сотрудники',
      );
    });

    it('404 на повторное удаление', async () => {
      const student = store.addStudent();
      const token = await actor('Permission.Students.Delete');

      await send('delete', `/api/v1/students/${student.id}`, token).expect(200);
      await send('delete', `/api/v1/students/${student.id}`, token).expect(404);
    });
  });

  describe('OpenAPI', () => {
    it('пути студентов описаны, создание отвечает 201', () => {
      const document = buildOpenApiDocument(app);

      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining(['/api/v1/students', '/api/v1/students/{id}']),
      );

      // Создание отвечает 201, а не дефолтным для POST 200: ровно такое
      // расхождение документа с кодом ловилось в сессии 0001.
      const create = document.paths['/api/v1/students']?.post;
      expect(create?.responses['201']).toBeDefined();
      expect(create?.responses['200']).toBeUndefined();

      expect(document.paths['/api/v1/students/{id}']?.put?.responses['200']).toBeDefined();
      expect(document.paths['/api/v1/students/{id}']?.delete?.responses['200']).toBeDefined();
    });
  });
});
