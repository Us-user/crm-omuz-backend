import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  AccountType,
  DirectoryStatus,
  LessonType,
  ResourceFileType,
  ResourceKind,
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
import { buildOpenApiDocument } from 'src/swagger';
import { SyllabusModule } from 'src/syllabus/syllabus.module';
import { SyllabusRepository } from 'src/syllabus/syllabus.repository';
import type {
  LessonListParams,
  LessonRow,
  LessonUpdateInput,
  LessonWriteInput,
  ResourceFileListParams,
  ResourceFileRow,
  ResourceFileWriteInput,
} from 'src/syllabus/syllabus.repository';

/** `{ data }` ответа с ожидаемым типом — тела supertest типизированы как `any`. */
const dataOf = <T>(response: { body: unknown }): T => (response.body as { data: T }).data;

/** Права аккаунта в памяти вместо трёх таблиц RBAC (как в `catalog.e2e-spec.ts`). */
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
}

/**
 * Силлабус в памяти. Курсы, группы, уроки и материалы держатся вместе, потому
 * что связаны правилами модуля: урок принадлежит курсу, мультивыбор «Show to
 * group» ограничен группами того же курса, а материал — своего урока.
 * Несогласованные заглушки проверяли бы не то поведение, которое даёт БД.
 */
class InMemorySyllabusStore {
  readonly courses = new Map<string, { id: string; title: string }>();
  readonly groups = new Map<string, StoredGroup>();
  readonly lessons = new Map<string, LessonRow>();
  readonly files = new Map<string, ResourceFileRow>();

  /** Видимость урока группам — отдельной связкой, как таблица в БД. */
  private readonly visibility = new Map<string, Set<string>>();

  addCourse(title: string): { id: string; title: string } {
    const course = { id: randomUUID(), title };
    this.courses.set(course.id, course);

    return course;
  }

  addGroup(courseId: string, name: string): StoredGroup {
    const group = { id: randomUUID(), name, courseId };
    this.groups.set(group.id, group);

    return group;
  }

  addLesson(courseId: string, overrides: Partial<LessonRow> = {}): LessonRow {
    const lesson: LessonRow = {
      id: randomUUID(),
      courseId,
      dayNumber: 1,
      title: `Урок ${String(this.lessons.size + 1)}`,
      description: null,
      type: LessonType.LECTURE,
      status: DirectoryStatus.ACTIVE,
      visibleToGroups: [],
      _count: { files: 0 },
      createdAt: new Date('2026-07-27T10:00:00.000Z'),
      ...overrides,
    };
    this.lessons.set(lesson.id, lesson);

    return lesson;
  }

  // ─── SyllabusRepository ───

  findLessons(params: LessonListParams): Promise<{ rows: LessonRow[]; total: number }> {
    const search = params.search?.toLowerCase();
    const matched = [...this.lessons.values()]
      .filter((lesson) => lesson.courseId === params.courseId)
      .filter((lesson) => params.type === undefined || lesson.type === params.type)
      .filter((lesson) => params.status === undefined || lesson.status === params.status)
      .filter(
        (lesson) =>
          params.groupId === undefined ||
          (this.visibility.get(lesson.id)?.has(params.groupId) ?? false),
      )
      .filter(
        (lesson) =>
          search === undefined ||
          [lesson.title, lesson.description ?? ''].some((field) =>
            field.toLowerCase().includes(search),
          ),
      )
      .map((lesson) => this.hydrate(lesson));

    const sort: string = params.sort;
    const order: string = params.order;

    matched.sort((a, b) => {
      const asc = sort === 'title' ? a.title.localeCompare(b.title) : a.dayNumber - b.dayNumber;

      return order === 'asc' ? asc : -asc;
    });

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findLesson(courseId: string, lessonId: string): Promise<LessonRow | null> {
    const lesson = this.lessons.get(lessonId);

    // Условие повторяет `where: { id, courseId }`: урок чужого курса не найдётся.
    return Promise.resolve(lesson && lesson.courseId === courseId ? this.hydrate(lesson) : null);
  }

  findCourse(id: string): Promise<{ id: string; title: string } | null> {
    return Promise.resolve(this.courses.get(id) ?? null);
  }

  findCourseGroups(courseId: string, groupIds: string[]): Promise<{ id: string; name: string }[]> {
    return Promise.resolve(
      groupIds
        .map((id) => this.groups.get(id))
        .filter((group): group is StoredGroup => group !== undefined && group.courseId === courseId)
        .map((group) => ({ id: group.id, name: group.name })),
    );
  }

  createLesson(input: LessonWriteInput, visibleToGroupIds: string[]): Promise<LessonRow> {
    const lesson = this.addLesson(input.courseId, {
      dayNumber: input.dayNumber,
      title: input.title,
      description: input.description,
      type: input.type ?? LessonType.LECTURE,
      status: input.status ?? DirectoryStatus.ACTIVE,
    });
    this.visibility.set(lesson.id, new Set(visibleToGroupIds));

    return Promise.resolve(this.hydrate(lesson));
  }

  updateLesson(
    lessonId: string,
    input: LessonUpdateInput,
    visibleToGroupIds?: string[],
  ): Promise<LessonRow> {
    const lesson = this.lessons.get(lessonId);
    if (!lesson) throw new Error('Урока нет: тест построен неверно');

    for (const [key, value] of Object.entries(input)) {
      // `undefined` означает «поле не передано» — так же его пропускает Prisma.
      if (value !== undefined) Object.assign(lesson, { [key]: value });
    }

    // Переданный список заменяет набор целиком, не переданный — не трогает.
    if (visibleToGroupIds !== undefined) {
      this.visibility.set(lessonId, new Set(visibleToGroupIds));
    }

    return Promise.resolve(this.hydrate(lesson));
  }

  deleteLesson(lessonId: string): Promise<void> {
    this.lessons.delete(lessonId);
    this.visibility.delete(lessonId);
    // Каскад: материалы урока уходят вместе с ним.
    for (const [id, file] of this.files) {
      if (file.lessonId === lessonId) this.files.delete(id);
    }

    return Promise.resolve();
  }

  findFiles(params: ResourceFileListParams): Promise<{ rows: ResourceFileRow[]; total: number }> {
    const matched = [...this.files.values()]
      .filter((file) => file.lessonId === params.lessonId)
      .filter((file) => params.kind === undefined || file.kind === params.kind)
      .filter((file) => params.fileType === undefined || file.fileType === params.fileType);

    matched.sort((a, b) => a.title.localeCompare(b.title));

    return Promise.resolve({
      rows: matched.slice(params.skip, params.skip + params.take),
      total: matched.length,
    });
  }

  findFile(lessonId: string, fileId: string): Promise<ResourceFileRow | null> {
    const file = this.files.get(fileId);

    return Promise.resolve(file && file.lessonId === lessonId ? file : null);
  }

  createFile(input: ResourceFileWriteInput): Promise<ResourceFileRow> {
    const file: ResourceFileRow = {
      id: randomUUID(),
      lessonId: input.lessonId,
      title: input.title,
      kind: input.kind ?? ResourceKind.LECTURE,
      fileType: input.fileType ?? ResourceFileType.OTHER,
      url: input.url,
      description: input.description,
      createdAt: new Date('2026-07-27T11:00:00.000Z'),
    };
    this.files.set(file.id, file);

    return Promise.resolve(file);
  }

  deleteFile(fileId: string): Promise<void> {
    this.files.delete(fileId);

    return Promise.resolve();
  }

  // ─── Вспомогательное ───

  /** Мультивыбор и счётчик материалов считаются на лету — как `select`/`_count` в БД. */
  private hydrate(lesson: LessonRow): LessonRow {
    const groupIds = [...(this.visibility.get(lesson.id) ?? [])];

    lesson.visibleToGroups = groupIds
      .map((id) => this.groups.get(id))
      .filter((group): group is StoredGroup => group !== undefined)
      .map((group) => ({ group: { id: group.id, name: group.name } }))
      .sort((a, b) => a.group.name.localeCompare(b.group.name));

    lesson._count = {
      files: [...this.files.values()].filter((file) => file.lessonId === lesson.id).length,
    };

    return lesson;
  }
}

interface LessonBody {
  id: string;
  courseId: string;
  dayNumber: number;
  title: string;
  description: string | null;
  type: LessonType;
  status: DirectoryStatus;
  visibleToGroups: { id: string; name: string }[];
  filesCount: number;
}

interface FileBody {
  id: string;
  lessonId: string;
  title: string;
  kind: ResourceKind;
  fileType: ResourceFileType;
  url: string;
  description: string | null;
}

describe('Силлабус курса (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let store: InMemorySyllabusStore;
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
    (await tokens.issuePair({ sub: randomUUID(), sid: randomUUID(), type: AccountType.STUDENT }))
      .accessToken;

  beforeEach(async () => {
    store = new InMemorySyllabusStore();
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
        SyllabusModule,
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
      .overrideProvider(SyllabusRepository)
      .useValue({
        findLessons: (params: LessonListParams) => store.findLessons(params),
        findLesson: (courseId: string, lessonId: string) => store.findLesson(courseId, lessonId),
        findCourse: (id: string) => store.findCourse(id),
        findCourseGroups: (courseId: string, groupIds: string[]) =>
          store.findCourseGroups(courseId, groupIds),
        createLesson: (input: LessonWriteInput, visible: string[]) =>
          store.createLesson(input, visible),
        updateLesson: (id: string, input: LessonUpdateInput, visible?: string[]) =>
          store.updateLesson(id, input, visible),
        deleteLesson: (id: string) => store.deleteLesson(id),
        findFiles: (params: ResourceFileListParams) => store.findFiles(params),
        findFile: (lessonId: string, fileId: string) => store.findFile(lessonId, fileId),
        createFile: (input: ResourceFileWriteInput) => store.createFile(input),
        deleteFile: (id: string) => store.deleteFile(id),
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

  /** Курс с двумя группами и уроком — общая сцена большинства случаев. */
  const scene = () => {
    const course = store.addCourse('Frontend Basic');
    const group = store.addGroup(course.id, 'Frontend-1');
    const otherCourse = store.addCourse('Python Basic');
    const foreignGroup = store.addGroup(otherCourse.id, 'Python-1');

    return { course, group, otherCourse, foreignGroup };
  };

  describe('Доступ', () => {
    it('без токена — 401', async () => {
      const { course } = scene();

      await request(app.getHttpServer()).get(`/api/v1/courses/${course.id}/lessons`).expect(401);
    });

    it('студент не ведёт программу курса — 403 (ТЗ 3.2)', async () => {
      const { course } = scene();

      await get(`/api/v1/courses/${course.id}/lessons`, await studentToken()).expect(403);
    });

    it('сотрудник без прав — 403', async () => {
      const { course } = scene();

      const response = await get(`/api/v1/courses/${course.id}/lessons`, await actor()).expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('право на курсы не открывает силлабус — у него свой раздел прав', async () => {
      const { course } = scene();

      await get(
        `/api/v1/courses/${course.id}/lessons`,
        await actor('Permission.Courses.Views'),
      ).expect(403);
    });

    it('право на просмотр не даёт права на добавление урока', async () => {
      const { course } = scene();
      const token = await actor('Permission.Syllabus.Views');

      await get(`/api/v1/courses/${course.id}/lessons`, token).expect(200);
      await send('post', `/api/v1/courses/${course.id}/lessons`, token, {
        dayNumber: 1,
        title: 'Вёрстка',
      }).expect(403);
    });

    it('удаление требует своего права, а не права на правку', async () => {
      const { course } = scene();
      const lesson = store.addLesson(course.id);

      await send(
        'delete',
        `/api/v1/courses/${course.id}/lessons/${lesson.id}`,
        await actor('Permission.Syllabus.Update'),
      ).expect(403);
    });
  });

  describe('Уроки программы (ТЗ 5.6)', () => {
    it('добавляет урок с типом и открывает его группе курса', async () => {
      const { course, group } = scene();
      const token = await actor('Permission.Syllabus.Create');

      const response = await send('post', `/api/v1/courses/${course.id}/lessons`, token, {
        dayNumber: 3,
        title: 'Экзамен по вёрстке',
        description: 'Итоговая работа',
        type: LessonType.EXAM,
        visibleToGroupIds: [group.id],
      }).expect(201);

      expect(dataOf<LessonBody>(response)).toMatchObject({
        courseId: course.id,
        dayNumber: 3,
        title: 'Экзамен по вёрстке',
        type: LessonType.EXAM,
        status: DirectoryStatus.ACTIVE,
        visibleToGroups: [{ id: group.id, name: 'Frontend-1' }],
        filesCount: 0,
      });
    });

    it('группа другого курса в «Show to group» — 422, урок не создан', async () => {
      const { course, foreignGroup } = scene();
      const token = await actor('Permission.Syllabus.Create', 'Permission.Syllabus.Views');

      const response = await send('post', `/api/v1/courses/${course.id}/lessons`, token, {
        dayNumber: 1,
        title: 'Вёрстка',
        visibleToGroupIds: [foreignGroup.id],
      }).expect(422);

      expect(response.body.error.details).toEqual({ visibleToGroupIds: [foreignGroup.id] });

      const list = await get(`/api/v1/courses/${course.id}/lessons`, token).expect(200);
      expect(list.body.meta.total).toBe(0);
    });

    it('два урока в один день допустимы — лекция и практика', async () => {
      const { course } = scene();
      const token = await actor('Permission.Syllabus.Create');

      await send('post', `/api/v1/courses/${course.id}/lessons`, token, {
        dayNumber: 1,
        title: 'Лекция: блочная модель',
        type: LessonType.LECTURE,
      }).expect(201);

      await send('post', `/api/v1/courses/${course.id}/lessons`, token, {
        dayNumber: 1,
        title: 'Практика: блочная модель',
        type: LessonType.PRACTICE,
      }).expect(201);
    });

    it('отдаёт программу в порядке дней с `{ data, meta }`', async () => {
      const { course } = scene();
      store.addLesson(course.id, { dayNumber: 3, title: 'День 3' });
      store.addLesson(course.id, { dayNumber: 1, title: 'День 1' });
      store.addLesson(course.id, { dayNumber: 2, title: 'День 2' });

      const response = await get(
        `/api/v1/courses/${course.id}/lessons`,
        await actor('Permission.Syllabus.Views'),
      ).expect(200);

      expect(response.body.meta).toMatchObject({ total: 3, page: 1, limit: 20 });
      expect(dataOf<LessonBody[]>(response).map((lesson) => lesson.dayNumber)).toEqual([1, 2, 3]);
    });

    it('уроки чужого курса в программу не попадают', async () => {
      const { course, otherCourse } = scene();
      store.addLesson(course.id, { title: 'Свой' });
      store.addLesson(otherCourse.id, { title: 'Чужой' });

      const response = await get(
        `/api/v1/courses/${course.id}/lessons`,
        await actor('Permission.Syllabus.Views'),
      ).expect(200);

      expect(dataOf<LessonBody[]>(response)).toHaveLength(1);
      expect(dataOf<LessonBody[]>(response)[0]?.title).toBe('Свой');
    });

    it('фильтрует по типу занятия и по группе («Show to group»)', async () => {
      const { course, group } = scene();
      const token = await actor('Permission.Syllabus.Views', 'Permission.Syllabus.Create');

      await send('post', `/api/v1/courses/${course.id}/lessons`, token, {
        dayNumber: 1,
        title: 'Лекция',
        type: LessonType.LECTURE,
        visibleToGroupIds: [group.id],
      }).expect(201);
      await send('post', `/api/v1/courses/${course.id}/lessons`, token, {
        dayNumber: 2,
        title: 'Экзамен',
        type: LessonType.EXAM,
      }).expect(201);

      const exams = await get(
        `/api/v1/courses/${course.id}/lessons?type=${LessonType.EXAM}`,
        token,
      ).expect(200);
      expect(dataOf<LessonBody[]>(exams).map((lesson) => lesson.title)).toEqual(['Экзамен']);

      const forGroup = await get(
        `/api/v1/courses/${course.id}/lessons?groupId=${group.id}`,
        token,
      ).expect(200);
      expect(dataOf<LessonBody[]>(forGroup).map((lesson) => lesson.title)).toEqual(['Лекция']);
    });

    it('урок чужого курса не читается по своему адресу — 404', async () => {
      const { course, otherCourse } = scene();
      const lesson = store.addLesson(otherCourse.id);

      await get(
        `/api/v1/courses/${course.id}/lessons/${lesson.id}`,
        await actor('Permission.Syllabus.Views'),
      ).expect(404);
    });

    it('неизвестный курс — 404 и на списке, и на добавлении', async () => {
      const token = await actor('Permission.Syllabus.Views', 'Permission.Syllabus.Create');
      const unknown = randomUUID();

      await get(`/api/v1/courses/${unknown}/lessons`, token).expect(404);
      await send('post', `/api/v1/courses/${unknown}/lessons`, token, {
        dayNumber: 1,
        title: 'Вёрстка',
      }).expect(404);
    });

    it('не-UUID в пути — 400, а не ошибка БД', async () => {
      const { course } = scene();
      const token = await actor('Permission.Syllabus.Views');

      await get('/api/v1/courses/не-uuid/lessons', token).expect(400);
      await get(`/api/v1/courses/${course.id}/lessons/не-uuid`, token).expect(400);
    });

    it('400 на номер дня вне границ, короткое название и лишнее поле', async () => {
      const { course } = scene();
      const token = await actor('Permission.Syllabus.Create');
      const url = `/api/v1/courses/${course.id}/lessons`;

      await send('post', url, token, { dayNumber: 0, title: 'Вёрстка' }).expect(400);
      await send('post', url, token, { dayNumber: 400, title: 'Вёрстка' }).expect(400);
      await send('post', url, token, { dayNumber: 1, title: 'X' }).expect(400);
      await send('post', url, token, { dayNumber: 1, title: 'Вёрстка', extra: 1 }).expect(400);
    });

    it('400 на не-UUID и на повтор в мультивыборе', async () => {
      const { course, group } = scene();
      const token = await actor('Permission.Syllabus.Create');
      const url = `/api/v1/courses/${course.id}/lessons`;

      await send('post', url, token, {
        dayNumber: 1,
        title: 'Вёрстка',
        visibleToGroupIds: ['не-uuid'],
      }).expect(400);

      await send('post', url, token, {
        dayNumber: 1,
        title: 'Вёрстка',
        visibleToGroupIds: [group.id, group.id],
      }).expect(400);
    });
  });

  describe('Правка урока', () => {
    it('меняет день и тип, очищает описание пустой строкой', async () => {
      const { course } = scene();
      const lesson = store.addLesson(course.id, { description: 'Старое описание' });
      const token = await actor('Permission.Syllabus.Update');

      const response = await send(
        'put',
        `/api/v1/courses/${course.id}/lessons/${lesson.id}`,
        token,
        { dayNumber: 5, type: LessonType.PRACTICE, description: '' },
      ).expect(200);

      expect(dataOf<LessonBody>(response)).toMatchObject({
        dayNumber: 5,
        type: LessonType.PRACTICE,
        description: null,
      });
    });

    it('мультивыбор заменяется целиком, пустой массив снимает всех', async () => {
      const { course, group } = scene();
      const second = store.addGroup(course.id, 'Frontend-2');
      const token = await actor('Permission.Syllabus.Update', 'Permission.Syllabus.Create');

      const created = dataOf<LessonBody>(
        await send('post', `/api/v1/courses/${course.id}/lessons`, token, {
          dayNumber: 1,
          title: 'Вёрстка',
          visibleToGroupIds: [group.id],
        }).expect(201),
      );

      const url = `/api/v1/courses/${course.id}/lessons/${created.id}`;

      const replaced = await send('put', url, token, {
        visibleToGroupIds: [second.id],
      }).expect(200);
      expect(dataOf<LessonBody>(replaced).visibleToGroups).toEqual([
        { id: second.id, name: 'Frontend-2' },
      ]);

      // Не переданное поле мультивыбор не трогает.
      const untouched = await send('put', url, token, { title: 'Вёрстка 2' }).expect(200);
      expect(dataOf<LessonBody>(untouched).visibleToGroups).toHaveLength(1);

      const cleared = await send('put', url, token, { visibleToGroupIds: [] }).expect(200);
      expect(dataOf<LessonBody>(cleared).visibleToGroups).toEqual([]);
    });

    it('группа другого курса при правке — 422, урок не изменился', async () => {
      const { course, foreignGroup } = scene();
      const lesson = store.addLesson(course.id, { title: 'Вёрстка' });
      const token = await actor('Permission.Syllabus.Update', 'Permission.Syllabus.Views');
      const url = `/api/v1/courses/${course.id}/lessons/${lesson.id}`;

      await send('put', url, token, {
        title: 'Новое название',
        visibleToGroupIds: [foreignGroup.id],
      }).expect(422);

      const after = await get(url, token).expect(200);
      expect(dataOf<LessonBody>(after).title).toBe('Вёрстка');
    });

    it('урок чужого курса не правится по своему адресу — 404', async () => {
      const { course, otherCourse } = scene();
      const lesson = store.addLesson(otherCourse.id);

      await send(
        'put',
        `/api/v1/courses/${course.id}/lessons/${lesson.id}`,
        await actor('Permission.Syllabus.Update'),
        { title: 'Взлом' },
      ).expect(404);
    });
  });

  describe('Материалы урока (ТЗ 5.6)', () => {
    it('добавляет материал с обоими типами и отдаёт его в списке', async () => {
      const { course } = scene();
      const lesson = store.addLesson(course.id);
      const token = await actor('Permission.Syllabus.Create', 'Permission.Syllabus.Views');
      const url = `/api/v1/courses/${course.id}/lessons/${lesson.id}/files`;

      const created = await send('post', url, token, {
        title: 'Домашка 1',
        kind: ResourceKind.HOMEWORK,
        fileType: ResourceFileType.DOC,
        url: 'https://cdn.omuz.tj/hw-1.docx',
      }).expect(201);

      expect(dataOf<FileBody>(created)).toMatchObject({
        lessonId: lesson.id,
        title: 'Домашка 1',
        kind: ResourceKind.HOMEWORK,
        fileType: ResourceFileType.DOC,
        url: 'https://cdn.omuz.tj/hw-1.docx',
      });

      const list = await get(url, token).expect(200);
      expect(list.body.meta.total).toBe(1);
    });

    it('счётчик материалов виден в карточке урока', async () => {
      const { course } = scene();
      const lesson = store.addLesson(course.id);
      const token = await actor('Permission.Syllabus.Create', 'Permission.Syllabus.Views');

      await send('post', `/api/v1/courses/${course.id}/lessons/${lesson.id}/files`, token, {
        title: 'Лекция 1',
        url: 'https://cdn.omuz.tj/day-1.pdf',
      }).expect(201);

      const card = await get(`/api/v1/courses/${course.id}/lessons/${lesson.id}`, token).expect(
        200,
      );
      expect(dataOf<LessonBody>(card).filesCount).toBe(1);
    });

    it('фильтрует материалы по разделу урока', async () => {
      const { course } = scene();
      const lesson = store.addLesson(course.id);
      const token = await actor('Permission.Syllabus.Create', 'Permission.Syllabus.Views');
      const url = `/api/v1/courses/${course.id}/lessons/${lesson.id}/files`;

      await send('post', url, token, {
        title: 'Лекция',
        kind: ResourceKind.LECTURE,
        url: 'https://cdn.omuz.tj/l.pdf',
      }).expect(201);
      await send('post', url, token, {
        title: 'Домашка',
        kind: ResourceKind.HOMEWORK,
        url: 'https://cdn.omuz.tj/h.pdf',
      }).expect(201);

      const homework = await get(`${url}?kind=${ResourceKind.HOMEWORK}`, token).expect(200);
      expect(dataOf<FileBody[]>(homework).map((file) => file.title)).toEqual(['Домашка']);
    });

    it('400 на ссылку без схемы и на ссылку без протокола', async () => {
      const { course } = scene();
      const lesson = store.addLesson(course.id);
      const token = await actor('Permission.Syllabus.Create');
      const url = `/api/v1/courses/${course.id}/lessons/${lesson.id}/files`;

      await send('post', url, token, { title: 'Материал', url: 'не ссылка' }).expect(400);
      await send('post', url, token, { title: 'Материал', url: 'cdn.omuz.tj/f.pdf' }).expect(400);
    });

    it('материал урока чужого курса не читается и не добавляется — 404', async () => {
      const { course, otherCourse } = scene();
      const lesson = store.addLesson(otherCourse.id);
      const token = await actor('Permission.Syllabus.Views', 'Permission.Syllabus.Create');
      const url = `/api/v1/courses/${course.id}/lessons/${lesson.id}/files`;

      await get(url, token).expect(404);
      await send('post', url, token, {
        title: 'Материал',
        url: 'https://cdn.omuz.tj/f.pdf',
      }).expect(404);
    });

    it('удаляет материал и называет удалённое', async () => {
      const { course } = scene();
      const lesson = store.addLesson(course.id);
      const token = await actor(
        'Permission.Syllabus.Create',
        'Permission.Syllabus.Delete',
        'Permission.Syllabus.Views',
      );
      const url = `/api/v1/courses/${course.id}/lessons/${lesson.id}/files`;

      const file = dataOf<FileBody>(
        await send('post', url, token, {
          title: 'Лекция 1',
          url: 'https://cdn.omuz.tj/day-1.pdf',
        }).expect(201),
      );

      const deleted = await send('delete', `${url}/${file.id}`, token).expect(200);
      expect(dataOf<{ id: string; title: string }>(deleted)).toEqual({
        id: file.id,
        title: 'Лекция 1',
      });

      const list = await get(url, token).expect(200);
      expect(list.body.meta.total).toBe(0);
    });

    it('материал другого урока по этому адресу не удаляется — 404', async () => {
      const { course } = scene();
      const lesson = store.addLesson(course.id);
      const other = store.addLesson(course.id, { dayNumber: 2 });
      const token = await actor('Permission.Syllabus.Create', 'Permission.Syllabus.Delete');

      const file = dataOf<FileBody>(
        await send('post', `/api/v1/courses/${course.id}/lessons/${lesson.id}/files`, token, {
          title: 'Лекция 1',
          url: 'https://cdn.omuz.tj/day-1.pdf',
        }).expect(201),
      );

      await send(
        'delete',
        `/api/v1/courses/${course.id}/lessons/${other.id}/files/${file.id}`,
        token,
      ).expect(404);
    });
  });

  describe('Удаление урока', () => {
    it('уносит материалы вместе с уроком (каскад)', async () => {
      const { course } = scene();
      const lesson = store.addLesson(course.id);
      const token = await actor(
        'Permission.Syllabus.Create',
        'Permission.Syllabus.Delete',
        'Permission.Syllabus.Views',
      );

      await send('post', `/api/v1/courses/${course.id}/lessons/${lesson.id}/files`, token, {
        title: 'Лекция 1',
        url: 'https://cdn.omuz.tj/day-1.pdf',
      }).expect(201);

      const deleted = await send(
        'delete',
        `/api/v1/courses/${course.id}/lessons/${lesson.id}`,
        token,
      ).expect(200);
      expect(dataOf<{ id: string; dayNumber: number }>(deleted)).toMatchObject({
        id: lesson.id,
        dayNumber: 1,
      });

      expect(store.files.size).toBe(0);
      await get(`/api/v1/courses/${course.id}/lessons/${lesson.id}`, token).expect(404);
    });

    it('урок чужого курса не удаляется — 404', async () => {
      const { course, otherCourse } = scene();
      const lesson = store.addLesson(otherCourse.id);

      await send(
        'delete',
        `/api/v1/courses/${course.id}/lessons/${lesson.id}`,
        await actor('Permission.Syllabus.Delete'),
      ).expect(404);
      expect(store.lessons.has(lesson.id)).toBe(true);
    });
  });

  describe('OpenAPI', () => {
    it('документ описывает маршруты силлабуса и код 201 на создание', () => {
      // Документ собирается напрямую: маршрут `/docs/json` монтируется только
      // при `SWAGGER_ENABLED=true`, а в CI Swagger выключен (сессия 0006).
      const document = buildOpenApiDocument(app);

      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/courses/{courseId}/lessons',
          '/api/v1/courses/{courseId}/lessons/{lessonId}',
          '/api/v1/courses/{courseId}/lessons/{lessonId}/files',
          '/api/v1/courses/{courseId}/lessons/{lessonId}/files/{fileId}',
        ]),
      );

      for (const path of [
        '/api/v1/courses/{courseId}/lessons',
        '/api/v1/courses/{courseId}/lessons/{lessonId}/files',
      ]) {
        expect(Object.keys(document.paths[path]?.post?.responses ?? {})).toContain('201');
      }
    });
  });
});
