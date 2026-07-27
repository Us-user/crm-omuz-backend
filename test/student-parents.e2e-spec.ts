import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountType, ParentRelation } from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, SortOrder, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { PhoneModule } from 'src/phone/phone.module';
import { RbacModule } from 'src/rbac/rbac.module';
import { RbacRepository } from 'src/rbac/rbac.repository';
import { StudentParentsModule } from 'src/student-parents/student-parents.module';
import type {
  CreateParentInput,
  LinkParentInput,
  ParentLinkRow,
  ParentListParams,
  ParentRow,
  UnlinkParentResult,
  UpdateParentInput,
} from 'src/student-parents/student-parents.repository';
import { StudentParentsRepository } from 'src/student-parents/student-parents.repository';
import { StudentParentSortField } from 'src/student-parents/dto';
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

interface StoredLink {
  studentId: string;
  parentId: string;
  relation: ParentRelation | null;
  createdAt: Date;
}

/**
 * Студенты, родители и связки вместе — иначе главное свойство модели проверить
 * нечем: запись родителя **общая**, у неё бывает несколько детей, и правка
 * контактов у одного ребёнка обязана быть видна у другого, а степень родства —
 * нет. Три несогласованные заглушки проверяли бы не то поведение, которое даёт БД.
 */
class InMemoryParentsStore {
  readonly students = new Set<string>();
  readonly parents = new Map<string, ParentRow>();
  readonly links: StoredLink[] = [];

  addStudent(): string {
    const id = randomUUID();
    this.students.add(id);

    return id;
  }

  /** Родитель, заведённый регистрацией (ТЗ 3.1): известен только номер. */
  addBareParent(phone: string): ParentRow {
    const parent: ParentRow = {
      id: randomUUID(),
      firstName: null,
      lastName: null,
      phone,
      email: null,
      telegram: null,
      notes: null,
    };
    this.parents.set(parent.id, parent);

    return parent;
  }

  childrenOf(parentId: string): number {
    return this.links.filter((link) => link.parentId === parentId).length;
  }

  private row(link: StoredLink): ParentLinkRow {
    const parent = this.parents.get(link.parentId);
    if (!parent) throw new Error(`Родитель ${link.parentId} не найден в хранилище`);

    return {
      relation: link.relation,
      createdAt: link.createdAt,
      parent: { ...parent, _count: { students: this.childrenOf(link.parentId) } },
    };
  }

  // ─── StudentParentsRepository ───

  findMany(params: ParentListParams): Promise<{ rows: ParentLinkRow[]; total: number }> {
    const search = params.search?.toLowerCase();

    const matched = this.links
      .filter((link) => link.studentId === params.studentId)
      .filter((link) => params.relation === undefined || link.relation === params.relation)
      .map((link) => this.row(link))
      .filter((row) => {
        if (search === undefined) return true;
        const { firstName, lastName, phone } = row.parent;

        return (
          [firstName, lastName].some((part) => part?.toLowerCase().includes(search)) ||
          phone.includes(search)
        );
      })
      .sort((a, b) => {
        const asc =
          params.sort === StudentParentSortField.Name
            ? `${a.parent.lastName ?? ''} ${a.parent.firstName ?? ''}`.localeCompare(
                `${b.parent.lastName ?? ''} ${b.parent.firstName ?? ''}`,
              )
            : a.createdAt.getTime() - b.createdAt.getTime();

        return params.order === SortOrder.Asc ? asc : -asc;
      });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findStudent(id: string): Promise<{ id: string } | null> {
    return Promise.resolve(this.students.has(id) ? { id } : null);
  }

  findParentByPhone(phone: string): Promise<ParentRow | null> {
    return Promise.resolve([...this.parents.values()].find((row) => row.phone === phone) ?? null);
  }

  findLink(studentId: string, parentId: string): Promise<ParentLinkRow | null> {
    const link = this.links.find((row) => row.studentId === studentId && row.parentId === parentId);

    return Promise.resolve(link ? this.row(link) : null);
  }

  create(input: CreateParentInput): Promise<ParentLinkRow> {
    const parent: ParentRow = {
      id: randomUUID(),
      firstName: input.parent.firstName ?? null,
      lastName: input.parent.lastName ?? null,
      phone: input.parent.phone,
      email: input.parent.email ?? null,
      telegram: input.parent.telegram ?? null,
      notes: input.parent.notes ?? null,
    };
    this.parents.set(parent.id, parent);

    return this.link({
      studentId: input.studentId,
      parentId: parent.id,
      relation: input.relation,
      fill: {},
    });
  }

  link(input: LinkParentInput): Promise<ParentLinkRow> {
    const parent = this.parents.get(input.parentId);
    if (parent) this.parents.set(parent.id, { ...parent, ...input.fill });

    const link: StoredLink = {
      studentId: input.studentId,
      parentId: input.parentId,
      relation: input.relation,
      // Время разводится по числу связок: иначе порядок добавления зависел бы
      // от того, уложились ли вставки в одну миллисекунду.
      createdAt: new Date(Date.now() + this.links.length),
    };
    this.links.push(link);

    return Promise.resolve(this.row(link));
  }

  update(input: UpdateParentInput): Promise<ParentLinkRow> {
    const parent = this.parents.get(input.parentId);
    if (parent) this.parents.set(parent.id, { ...parent, ...input.parent });

    const link = this.links.find(
      (row) => row.studentId === input.studentId && row.parentId === input.parentId,
    );
    if (!link) throw new Error('Связка не найдена в хранилище');
    if (input.relation !== undefined) link.relation = input.relation;

    return Promise.resolve(this.row(link));
  }

  unlink(studentId: string, parentId: string): Promise<UnlinkParentResult> {
    const index = this.links.findIndex(
      (row) => row.studentId === studentId && row.parentId === parentId,
    );
    if (index >= 0) this.links.splice(index, 1);

    if (this.childrenOf(parentId) > 0) {
      return Promise.resolve({ parentDeleted: false });
    }

    this.parents.delete(parentId);

    return Promise.resolve({ parentDeleted: true });
  }
}

interface ParentBody {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phone: string;
  email: string | null;
  telegram: string | null;
  notes: string | null;
  relation: ParentRelation | null;
  childrenCount: number;
  linkedAt: string;
  created?: boolean;
}

describe('Студенты: родители и опекуны (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemoryParentsStore;
  let rbac: InMemoryRbacRepository;
  let tokens: TokenService;

  beforeEach(async () => {
    store = new InMemoryParentsStore();
    rbac = new InMemoryRbacRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        PhoneModule,
        AuthModule,
        RbacModule,
        StudentParentsModule,
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
      .overrideProvider(StudentParentsRepository)
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

  const get = (url: string, token: string) =>
    request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);

  const post = (url: string, token: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${token}`).send(body);

  const put = (url: string, token: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).put(url).set('Authorization', `Bearer ${token}`).send(body);

  const del = (url: string, token: string) =>
    request(app.getHttpServer()).delete(url).set('Authorization', `Bearer ${token}`);

  const parentsUrl = (studentId: string) => `/api/v1/students/${studentId}/parents`;

  /** Полный набор прав раздела — чтобы сценарные тесты не перечисляли их каждый раз. */
  const manager = () =>
    actor(
      'Permission.Parents.Views',
      'Permission.Parents.Create',
      'Permission.Parents.Update',
      'Permission.Parents.Delete',
    );

  const listOf = async (studentId: string, token: string, query = ''): Promise<ParentBody[]> => {
    const response = await get(`${parentsUrl(studentId)}${query}`, token).expect(200);

    return (response.body as { data: ParentBody[] }).data;
  };

  describe('Доступ', () => {
    it('без токена — 401', async () => {
      await request(app.getHttpServer()).get(parentsUrl(store.addStudent())).expect(401);
    });

    it('студент контакты родителей не читает — 403 (ТЗ 3.2)', async () => {
      await get(parentsUrl(store.addStudent()), await studentToken()).expect(403);
    });

    it('сотрудник без прав — 403', async () => {
      await get(parentsUrl(store.addStudent()), await actor()).expect(403);
    });

    it('право на карточки студентов родителей не открывает', async () => {
      await get(parentsUrl(store.addStudent()), await actor('Permission.Students.Views')).expect(
        403,
      );
    });

    it('право на просмотр не даёт добавлять', async () => {
      const student = store.addStudent();
      const token = await actor('Permission.Parents.Views');

      await get(parentsUrl(student), token).expect(200);
      await post(parentsUrl(student), token, { phone: '+992907654321' }).expect(403);
    });

    it('добавление и удаление требуют разных прав', async () => {
      const student = store.addStudent();
      const creator = await actor('Permission.Parents.Create');
      const created = await post(parentsUrl(student), creator, {
        phone: '+992907654321',
      }).expect(201);
      const id = dataOf<ParentBody>(created).id;

      await del(`${parentsUrl(student)}/${id}`, creator).expect(403);
      await del(`${parentsUrl(student)}/${id}`, await actor('Permission.Parents.Delete')).expect(
        200,
      );
    });
  });

  describe('Добавление (ТЗ 4: Parent/Guardian)', () => {
    it('заводит родителя с телефоном в E.164', async () => {
      const student = store.addStudent();

      const response = await post(parentsUrl(student), await manager(), {
        phone: '90 765-43-21',
        firstName: 'Гулнора',
        lastName: 'Каримова',
        email: 'Gulnora@Mail.TJ',
        relation: ParentRelation.MOTHER,
      }).expect(201);

      expect(dataOf<ParentBody>(response)).toMatchObject({
        phone: '+992907654321',
        firstName: 'Гулнора',
        lastName: 'Каримова',
        email: 'gulnora@mail.tj',
        relation: ParentRelation.MOTHER,
        childrenCount: 1,
        created: true,
      });
    });

    it('двое родителей у одного студента', async () => {
      const student = store.addStudent();
      const token = await manager();

      await post(parentsUrl(student), token, {
        phone: '+992907654321',
        lastName: 'Каримова',
        relation: ParentRelation.MOTHER,
      }).expect(201);
      await post(parentsUrl(student), token, {
        phone: '+992901112233',
        lastName: 'Каримов',
        relation: ParentRelation.FATHER,
      }).expect(201);

      expect((await listOf(student, token)).map(({ relation }) => relation)).toEqual([
        ParentRelation.MOTHER,
        ParentRelation.FATHER,
      ]);
    });

    it('второму ребёнку привязывается та же запись, а не её копия', async () => {
      const elder = store.addStudent();
      const younger = store.addStudent();
      const token = await manager();

      const first = await post(parentsUrl(elder), token, {
        phone: '+992907654321',
        lastName: 'Каримова',
        relation: ParentRelation.MOTHER,
      }).expect(201);

      const second = await post(parentsUrl(younger), token, {
        phone: '+992 90 765-43-21',
        relation: ParentRelation.GUARDIAN,
      }).expect(201);

      expect(dataOf<ParentBody>(second)).toMatchObject({
        id: dataOf<ParentBody>(first).id,
        // Фамилия взята из уже заведённой записи, а не потеряна.
        lastName: 'Каримова',
        created: false,
        childrenCount: 2,
      });
      expect(store.parents.size).toBe(1);
    });

    it('пустые поля существующей записи дозаполняются', async () => {
      // Так выглядит родитель, заведённый регистрацией (ТЗ 3.1): только номер.
      const bare = store.addBareParent('+992907654321');
      const student = store.addStudent();
      await post(parentsUrl(student), await manager(), { phone: '+992907654321' }).expect(201);

      const response = await put(`${parentsUrl(student)}/${bare.id}`, await manager(), {}).expect(
        200,
      );
      expect(dataOf<ParentBody>(response).firstName).toBeNull();

      const other = store.addStudent();
      const filled = await post(parentsUrl(other), await manager(), {
        phone: '+992907654321',
        firstName: 'Гулнора',
        lastName: 'Каримова',
      }).expect(201);

      expect(dataOf<ParentBody>(filled)).toMatchObject({
        id: bare.id,
        firstName: 'Гулнора',
        lastName: 'Каримова',
      });
    });

    it('заполненное имя чужой карточкой не перезаписывается', async () => {
      const elder = store.addStudent();
      const younger = store.addStudent();
      const token = await manager();

      await post(parentsUrl(elder), token, {
        phone: '+992907654321',
        firstName: 'Гулнора',
      }).expect(201);

      const second = await post(parentsUrl(younger), token, {
        phone: '+992907654321',
        firstName: 'Гулноро',
        notes: 'звонить после 18:00',
      }).expect(201);

      expect(dataOf<ParentBody>(second)).toMatchObject({
        firstName: 'Гулнора',
        // Пустое поле при этом дозаполнилось.
        notes: 'звонить после 18:00',
      });
    });

    it('409 на повторное добавление того же родителя студенту', async () => {
      const student = store.addStudent();
      const token = await manager();

      await post(parentsUrl(student), token, {
        phone: '+992907654321',
        firstName: 'Гулнора',
        lastName: 'Каримова',
      }).expect(201);

      const response = await post(parentsUrl(student), token, {
        phone: '907654321',
      }).expect(409);

      expect(JSON.stringify(response.body)).toContain('Каримова Гулнора');
      expect(await listOf(student, token)).toHaveLength(1);
    });

    it('400 на неразобранный номер, неизвестное родство и лишнее поле', async () => {
      const student = store.addStudent();
      const token = await manager();

      await post(parentsUrl(student), token, { phone: 'не телефон' }).expect(400);
      await post(parentsUrl(student), token, {
        phone: '+992907654321',
        relation: 'AUNT',
      }).expect(400);
      await post(parentsUrl(student), token, {
        phone: '+992907654321',
        childrenCount: 5,
      }).expect(400);
    });

    it('404 на неизвестного студента и 400 на не-UUID в пути', async () => {
      const token = await manager();

      await post(parentsUrl(randomUUID()), token, { phone: '+992907654321' }).expect(404);
      await post(parentsUrl('не-uuid'), token, { phone: '+992907654321' }).expect(400);
    });
  });

  describe('Список', () => {
    it('отдаёт `{ data, meta }` в порядке добавления', async () => {
      const student = store.addStudent();
      const token = await manager();

      await post(parentsUrl(student), token, { phone: '+992907654321', lastName: 'Яковлева' });
      await post(parentsUrl(student), token, { phone: '+992901112233', lastName: 'Абдуллоева' });

      const response = await get(parentsUrl(student), token).expect(200);
      const body = response.body as { data: ParentBody[]; meta: { total: number } };

      expect(body.meta).toMatchObject({ total: 2, page: 1, limit: 20 });
      expect(body.data.map(({ lastName }) => lastName)).toEqual(['Яковлева', 'Абдуллоева']);
    });

    it('сортировка по имени переставляет список по алфавиту', async () => {
      const student = store.addStudent();
      const token = await manager();

      await post(parentsUrl(student), token, { phone: '+992907654321', lastName: 'Яковлева' });
      await post(parentsUrl(student), token, { phone: '+992901112233', lastName: 'Абдуллоева' });

      expect((await listOf(student, token, '?sort=name')).map(({ lastName }) => lastName)).toEqual([
        'Абдуллоева',
        'Яковлева',
      ]);
    });

    it('фильтр по родству и поиск по фамилии и телефону', async () => {
      const student = store.addStudent();
      const token = await manager();

      await post(parentsUrl(student), token, {
        phone: '+992907654321',
        lastName: 'Каримова',
        relation: ParentRelation.MOTHER,
      });
      await post(parentsUrl(student), token, {
        phone: '+992901112233',
        lastName: 'Каримов',
        relation: ParentRelation.FATHER,
      });

      expect(
        (await listOf(student, token, `?relation=${ParentRelation.FATHER}`)).map(
          ({ phone }) => phone,
        ),
      ).toEqual(['+992901112233']);

      expect((await listOf(student, token, '?search=Каримова')).map(({ phone }) => phone)).toEqual([
        '+992907654321',
      ]);

      expect((await listOf(student, token, '?search=1112233')).map(({ phone }) => phone)).toEqual([
        '+992901112233',
      ]);
    });

    it('родители соседнего студента в список не попадают', async () => {
      const student = store.addStudent();
      const neighbour = store.addStudent();
      const token = await manager();

      await post(parentsUrl(student), token, { phone: '+992907654321', lastName: 'Каримова' });
      await post(parentsUrl(neighbour), token, { phone: '+992901112233', lastName: 'Сафарова' });

      expect((await listOf(student, token)).map(({ lastName }) => lastName)).toEqual(['Каримова']);
    });

    it('400 на неизвестное поле сортировки, 404 на неизвестного студента', async () => {
      const token = await manager();

      await get(`${parentsUrl(store.addStudent())}?sort=phone`, token).expect(400);
      await get(parentsUrl(randomUUID()), token).expect(404);
    });
  });

  describe('Правка', () => {
    it('меняет имя и родство, не трогая непереданное', async () => {
      const student = store.addStudent();
      const token = await manager();
      const created = await post(parentsUrl(student), token, {
        phone: '+992907654321',
        firstName: 'Гулнора',
        lastName: 'Каримова',
        relation: ParentRelation.MOTHER,
      }).expect(201);
      const id = dataOf<ParentBody>(created).id;

      const response = await put(`${parentsUrl(student)}/${id}`, token, {
        lastName: 'Каримова-Сафарова',
        relation: ParentRelation.GUARDIAN,
      }).expect(200);

      expect(dataOf<ParentBody>(response)).toMatchObject({
        firstName: 'Гулнора',
        lastName: 'Каримова-Сафарова',
        phone: '+992907654321',
        relation: ParentRelation.GUARDIAN,
      });
    });

    it('пустая строка очищает заметку, а пустое родство снимает', async () => {
      const student = store.addStudent();
      const token = await manager();
      const created = await post(parentsUrl(student), token, {
        phone: '+992907654321',
        notes: 'звонить после 18:00',
        relation: ParentRelation.MOTHER,
      }).expect(201);
      const id = dataOf<ParentBody>(created).id;

      const response = await put(`${parentsUrl(student)}/${id}`, token, {
        notes: '',
        relation: '',
      }).expect(200);

      expect(dataOf<ParentBody>(response)).toMatchObject({ notes: null, relation: null });
    });

    it('правка контактов видна в карточке второго ребёнка, а родство — нет', async () => {
      const elder = store.addStudent();
      const younger = store.addStudent();
      const token = await manager();

      const created = await post(parentsUrl(elder), token, {
        phone: '+992907654321',
        lastName: 'Каримова',
        relation: ParentRelation.MOTHER,
      }).expect(201);
      const id = dataOf<ParentBody>(created).id;

      await post(parentsUrl(younger), token, {
        phone: '+992907654321',
        relation: ParentRelation.GUARDIAN,
      }).expect(201);

      await put(`${parentsUrl(elder)}/${id}`, token, {
        phone: '+992905556677',
        relation: ParentRelation.FATHER,
      }).expect(200);

      // Общий контакт переехал вместе с записью…
      expect(await listOf(younger, token)).toMatchObject([
        { phone: '+992905556677', lastName: 'Каримова', relation: ParentRelation.GUARDIAN },
      ]);
      // …а степень родства осталась своей у каждого ребёнка.
      expect(await listOf(elder, token)).toMatchObject([{ relation: ParentRelation.FATHER }]);
    });

    it('409 на телефон другого родителя — слить записи нельзя', async () => {
      const student = store.addStudent();
      const token = await manager();
      const first = await post(parentsUrl(student), token, {
        phone: '+992907654321',
        lastName: 'Каримова',
      }).expect(201);
      await post(parentsUrl(student), token, {
        phone: '+992901112233',
        lastName: 'Каримов',
      }).expect(201);

      const response = await put(`${parentsUrl(student)}/${dataOf<ParentBody>(first).id}`, token, {
        phone: '+992901112233',
      }).expect(409);

      expect(JSON.stringify(response.body)).toContain('Каримов');
      expect((await listOf(student, token)).map(({ phone }) => phone)).toEqual([
        '+992907654321',
        '+992901112233',
      ]);
    });

    it('400 на пустой телефон — ключ записи не очищается', async () => {
      const student = store.addStudent();
      const token = await manager();
      const created = await post(parentsUrl(student), token, { phone: '+992907654321' });
      const id = dataOf<ParentBody>(created).id;

      await put(`${parentsUrl(student)}/${id}`, token, { phone: '' }).expect(400);

      expect((await listOf(student, token)).map(({ phone }) => phone)).toEqual(['+992907654321']);
    });

    it('404 на родителя соседнего студента', async () => {
      const student = store.addStudent();
      const neighbour = store.addStudent();
      const token = await manager();
      const created = await post(parentsUrl(neighbour), token, { phone: '+992907654321' });
      const id = dataOf<ParentBody>(created).id;

      await put(`${parentsUrl(student)}/${id}`, token, { lastName: 'Чужая' }).expect(404);
    });
  });

  describe('Отвязка', () => {
    it('убирает родителя и удаляет запись, если детей больше нет', async () => {
      const student = store.addStudent();
      const token = await manager();
      const created = await post(parentsUrl(student), token, {
        phone: '+992907654321',
        firstName: 'Гулнора',
        lastName: 'Каримова',
      }).expect(201);
      const id = dataOf<ParentBody>(created).id;

      const response = await del(`${parentsUrl(student)}/${id}`, token).expect(200);

      expect(dataOf<ParentBody & { fullName: string; parentDeleted: boolean }>(response)).toEqual({
        id,
        phone: '+992907654321',
        fullName: 'Каримова Гулнора',
        parentDeleted: true,
      });
      expect(await listOf(student, token)).toHaveLength(0);
      expect(store.parents.size).toBe(0);
    });

    it('у родителя с другим ребёнком запись остаётся', async () => {
      const elder = store.addStudent();
      const younger = store.addStudent();
      const token = await manager();
      const created = await post(parentsUrl(elder), token, {
        phone: '+992907654321',
        lastName: 'Каримова',
      }).expect(201);
      const id = dataOf<ParentBody>(created).id;
      await post(parentsUrl(younger), token, { phone: '+992907654321' }).expect(201);

      const response = await del(`${parentsUrl(elder)}/${id}`, token).expect(200);

      expect(dataOf<{ parentDeleted: boolean }>(response).parentDeleted).toBe(false);
      expect(await listOf(elder, token)).toHaveLength(0);
      expect(await listOf(younger, token)).toMatchObject([{ id, childrenCount: 1 }]);
    });

    it('404 на повторную отвязку', async () => {
      const student = store.addStudent();
      const token = await manager();
      const created = await post(parentsUrl(student), token, { phone: '+992907654321' });
      const id = dataOf<ParentBody>(created).id;

      await del(`${parentsUrl(student)}/${id}`, token).expect(200);
      await del(`${parentsUrl(student)}/${id}`, token).expect(404);
    });
  });

  describe('OpenAPI', () => {
    it('пути родителей описаны, добавление отвечает 201', () => {
      const document = buildOpenApiDocument(app);

      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/students/{studentId}/parents',
          '/api/v1/students/{studentId}/parents/{parentId}',
        ]),
      );

      const create = document.paths['/api/v1/students/{studentId}/parents']?.post;
      expect(create?.responses['201']).toBeDefined();
      expect(create?.responses['200']).toBeUndefined();
    });
  });
});
