import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  AccountType,
  DirectoryStatus,
  MailingAudience,
  MessageChannel,
  NotificationStatus,
} from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, SortOrder, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { MailingDeliveryService } from 'src/mailings/mailing-delivery.service';
import { MailingDispatcher } from 'src/mailings/mailing-dispatcher';
import { MailingsModule } from 'src/mailings/mailings.module';
import type {
  DeliveryCountRow,
  DeliveryRow,
  MailingListParams,
  MailingRow,
  MailingUpdateInput,
  MailingWriteInput,
  NotificationRow,
  NotificationSeed,
  RecipientRow,
  TemplateListParams,
  TemplateRow,
  TemplateUpdateInput,
  TemplateWriteInput,
} from 'src/mailings/mailings.repository';
import { MailingsRepository } from 'src/mailings/mailings.repository';
import { MessageSender } from 'src/messaging';
import { MessagingModule } from 'src/messaging/messaging.module';
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

interface StoredNotification extends NotificationSeed {
  mailingId: string;
  sentAt: Date | null;
  attempts: number;
  createdAt: Date;
}

/**
 * Шаблоны, рассылки, доставки **и все пять аудиторий** в одном хранилище.
 *
 * Отбор здесь **повторяет правила репозитория** (фильтры списков, «шаблон
 * без канала годится любому», только `FAILED` в повторе, действующий состав
 * группы), а не подставляет готовые строки: иначе главное свойство сессии —
 * «отправил → доставилось → видно в карточке получателя» — проверялось бы
 * заготовленным ответом, а не работой кода.
 */
class InMemoryStore {
  readonly templates = new Map<string, TemplateRow>();
  readonly mailings = new Map<string, MailingRow>();
  readonly notifications = new Map<string, StoredNotification>();
  readonly groups = new Map<string, { id: string; name: string }>();
  readonly employeesByAccount = new Map<string, { id: string }>();

  /** Аудитории задаются набором: e2e проверяет отбор, а не запросы Prisma. */
  groupStudents = new Map<string, RecipientRow[]>();
  activeStudents: RecipientRow[] = [];
  mentors: RecipientRow[] = [];
  leads: RecipientRow[] = [];
  graduates: RecipientRow[] = [];

  reset(): void {
    this.templates.clear();
    this.mailings.clear();
    this.notifications.clear();
    this.groups.clear();
    this.employeesByAccount.clear();
    this.groupStudents = new Map();
    this.activeStudents = [];
    this.mentors = [];
    this.leads = [];
    this.graduates = [];
  }

  // --- Шаблоны ----------------------------------------------------------

  findTemplates(params: TemplateListParams): Promise<{ rows: TemplateRow[]; total: number }> {
    let rows = [...this.templates.values()];

    if (params.status !== undefined) rows = rows.filter((row) => row.status === params.status);
    // Шаблон без канала годится любому — то же правило, что в репозитории.
    if (params.channel !== undefined) {
      rows = rows.filter((row) => row.channel === params.channel || row.channel === null);
    }
    if (params.search !== undefined) {
      const needle = params.search.toLowerCase();
      rows = rows.filter((row) =>
        [row.name, row.title, row.body].some((field) => field.toLowerCase().includes(needle)),
      );
    }

    rows.sort((a, b) => a.name.localeCompare(b.name));
    if (params.order === SortOrder.Desc) rows.reverse();

    const total = rows.length;

    return Promise.resolve({ rows: rows.slice(params.skip, params.skip + params.take), total });
  }

  findTemplateById(id: string): Promise<TemplateRow | null> {
    return Promise.resolve(this.templates.get(id) ?? null);
  }

  findTemplateByName(name: string): Promise<{ id: string; name: string } | null> {
    const found = [...this.templates.values()].find(
      (row) => row.name.toLowerCase() === name.toLowerCase(),
    );

    return Promise.resolve(found ? { id: found.id, name: found.name } : null);
  }

  createTemplate(input: TemplateWriteInput): Promise<TemplateRow> {
    const row: TemplateRow = {
      id: randomUUID(),
      name: input.name,
      title: input.title,
      body: input.body,
      channel: input.channel,
      status: input.status ?? DirectoryStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: null,
      _count: { mailings: 0 },
    };
    this.templates.set(row.id, row);

    return Promise.resolve(row);
  }

  updateTemplate(id: string, input: TemplateUpdateInput): Promise<TemplateRow> {
    const existing = this.templates.get(id);
    if (!existing) throw new Error('нет такого шаблона');

    const row: TemplateRow = {
      ...existing,
      name: input.name ?? existing.name,
      title: input.title ?? existing.title,
      body: input.body ?? existing.body,
      channel: input.channel === undefined ? existing.channel : input.channel,
      status: input.status ?? existing.status,
      updatedAt: new Date(),
    };
    this.templates.set(id, row);

    return Promise.resolve(row);
  }

  deleteTemplate(id: string): Promise<void> {
    this.templates.delete(id);

    // `SET NULL` со стороны рассылки: текст она хранит снимком и не теряет его.
    for (const [mailingId, mailing] of this.mailings) {
      if (mailing.template?.id === id) {
        this.mailings.set(mailingId, { ...mailing, template: null });
      }
    }

    return Promise.resolve();
  }

  // --- Рассылки ---------------------------------------------------------

  findMailings(params: MailingListParams): Promise<{ rows: MailingRow[]; total: number }> {
    let rows = [...this.mailings.values()];

    if (params.audience !== undefined) rows = rows.filter((r) => r.audience === params.audience);
    if (params.channel !== undefined) rows = rows.filter((r) => r.channel === params.channel);
    if (params.groupId !== undefined) rows = rows.filter((r) => r.group?.id === params.groupId);
    if (params.sent !== undefined) {
      rows = rows.filter((r) => (params.sent === true ? r.sentAt !== null : r.sentAt === null));
    }
    if (params.search !== undefined) {
      const needle = params.search.toLowerCase();
      rows = rows.filter((r) =>
        [r.title, r.body].some((field) => field.toLowerCase().includes(needle)),
      );
    }

    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = rows.length;

    return Promise.resolve({ rows: rows.slice(params.skip, params.skip + params.take), total });
  }

  findMailingById(id: string): Promise<MailingRow | null> {
    return Promise.resolve(this.mailings.get(id) ?? null);
  }

  createMailing(input: MailingWriteInput): Promise<MailingRow> {
    const row: MailingRow = {
      id: randomUUID(),
      title: input.title,
      body: input.body,
      channel: input.channel,
      audience: input.audience,
      sentAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      group: input.groupId === null ? null : (this.groups.get(input.groupId) ?? null),
      template: input.templateId === null ? null : this.templateRef(input.templateId),
      createdBy: null,
      sentBy: null,
    };
    this.mailings.set(row.id, row);

    if (input.templateId !== null) this.bumpTemplateUsage(input.templateId, 1);

    return Promise.resolve(row);
  }

  updateMailing(id: string, input: MailingUpdateInput): Promise<MailingRow> {
    const existing = this.mailings.get(id);
    if (!existing) throw new Error('нет такой рассылки');

    const row: MailingRow = {
      ...existing,
      title: input.title ?? existing.title,
      body: input.body ?? existing.body,
      channel: input.channel ?? existing.channel,
      audience: input.audience ?? existing.audience,
      group:
        input.groupId === undefined
          ? existing.group
          : input.groupId === null
            ? null
            : (this.groups.get(input.groupId) ?? null),
      template:
        input.templateId === undefined
          ? existing.template
          : input.templateId === null
            ? null
            : this.templateRef(input.templateId),
      updatedAt: new Date(),
    };
    this.mailings.set(id, row);

    return Promise.resolve(row);
  }

  deleteMailing(id: string): Promise<void> {
    this.mailings.delete(id);

    return Promise.resolve();
  }

  findGroup(id: string): Promise<{ id: string; name: string } | null> {
    return Promise.resolve(this.groups.get(id) ?? null);
  }

  // --- Доставки ---------------------------------------------------------

  countDeliveriesByMailing(mailingIds: string[]): Promise<DeliveryCountRow[]> {
    const buckets = new Map<string, number>();

    for (const row of this.notifications.values()) {
      if (!mailingIds.includes(row.mailingId)) continue;

      const key = `${row.mailingId} ${row.status}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }

    return Promise.resolve(
      [...buckets].map(([key, count]) => {
        const [mailingId, status] = key.split(' ');

        return {
          mailingId: mailingId ?? '',
          status: status as NotificationStatus,
          count,
        };
      }),
    );
  }

  findNotifications(params: {
    mailingId: string;
    status?: NotificationStatus;
    search?: string;
    skip: number;
    take: number;
  }): Promise<{ rows: NotificationRow[]; total: number }> {
    let rows = [...this.notifications.values()].filter((row) => row.mailingId === params.mailingId);

    if (params.status !== undefined) rows = rows.filter((row) => row.status === params.status);
    if (params.search !== undefined) {
      const needle = params.search.toLowerCase();
      rows = rows.filter((row) =>
        [row.recipientName, row.address].some((field) => field.toLowerCase().includes(needle)),
      );
    }

    rows.sort((a, b) => a.recipientName.localeCompare(b.recipientName) || a.id.localeCompare(b.id));

    const total = rows.length;
    const page = rows.slice(params.skip, params.skip + params.take).map((row): NotificationRow => ({
      id: row.id,
      channel: row.channel,
      recipientType: row.recipientType,
      recipientName: row.recipientName,
      address: row.address,
      studentId: row.studentId,
      employeeId: row.employeeId,
      leadId: row.leadId,
      status: row.status,
      error: row.error,
      attempts: row.attempts,
      sentAt: row.sentAt,
      createdAt: row.createdAt,
    }));

    return Promise.resolve({ rows: page, total });
  }

  findDelivery(id: string): Promise<DeliveryRow | null> {
    const row = this.notifications.get(id);
    if (!row) return Promise.resolve(null);

    const mailing = this.mailings.get(row.mailingId);

    return Promise.resolve({
      id: row.id,
      channel: row.channel,
      address: row.address,
      status: row.status,
      attempts: row.attempts,
      body: row.body ?? null,
      mailing: {
        id: row.mailingId,
        title: mailing?.title ?? '',
        body: mailing?.body ?? '',
      },
    });
  }

  markSent(params: {
    mailingId: string;
    sentAt: Date;
    sentById: string | null;
    notifications: NotificationSeed[];
  }): Promise<MailingRow> {
    for (const seed of params.notifications) {
      this.notifications.set(seed.id, {
        ...seed,
        mailingId: params.mailingId,
        attempts: 0,
        sentAt: null,
        createdAt: new Date(),
      });
    }

    const existing = this.mailings.get(params.mailingId);
    if (!existing) throw new Error('нет такой рассылки');

    const row: MailingRow = { ...existing, sentAt: params.sentAt, updatedAt: new Date() };
    this.mailings.set(params.mailingId, row);

    return Promise.resolve(row);
  }

  findRetryableDeliveryIds(mailingId: string): Promise<string[]> {
    return Promise.resolve(
      [...this.notifications.values()]
        .filter(
          (row) =>
            row.mailingId === mailingId &&
            (row.status === NotificationStatus.FAILED || row.status === NotificationStatus.PENDING),
        )
        .map((row) => row.id),
    );
  }

  resetDeliveries(ids: string[]): Promise<void> {
    for (const id of ids) {
      const row = this.notifications.get(id);
      if (row) {
        this.notifications.set(id, { ...row, status: NotificationStatus.PENDING, error: null });
      }
    }

    return Promise.resolve();
  }

  markDelivered(id: string, attempts: number, sentAt: Date): Promise<void> {
    const row = this.notifications.get(id);
    if (row) {
      this.notifications.set(id, {
        ...row,
        status: NotificationStatus.SENT,
        attempts,
        error: null,
        sentAt,
      });
    }

    return Promise.resolve();
  }

  markDeliveryFailed(id: string, attempts: number, error: string): Promise<void> {
    const row = this.notifications.get(id);
    if (row) {
      this.notifications.set(id, { ...row, status: NotificationStatus.FAILED, attempts, error });
    }

    return Promise.resolve();
  }

  registerAttempt(id: string, attempts: number, error: string): Promise<void> {
    const row = this.notifications.get(id);
    if (row) this.notifications.set(id, { ...row, attempts, error });

    return Promise.resolve();
  }

  // --- Аудитории --------------------------------------------------------

  findGroupStudents(groupId: string): Promise<RecipientRow[]> {
    return Promise.resolve(this.groupStudents.get(groupId) ?? []);
  }

  findActiveStudents(): Promise<RecipientRow[]> {
    return Promise.resolve(this.activeStudents);
  }

  findMentors(): Promise<RecipientRow[]> {
    return Promise.resolve(this.mentors);
  }

  findLeads(): Promise<RecipientRow[]> {
    return Promise.resolve(this.leads);
  }

  findGraduates(): Promise<RecipientRow[]> {
    return Promise.resolve(this.graduates);
  }

  findEmployeeByAccount(accountId: string): Promise<{ id: string } | null> {
    return Promise.resolve(this.employeesByAccount.get(accountId) ?? null);
  }

  private templateRef(id: string): { id: string; name: string } | null {
    const template = this.templates.get(id);

    return template ? { id: template.id, name: template.name } : null;
  }

  private bumpTemplateUsage(id: string, delta: number): void {
    const template = this.templates.get(id);
    if (template) {
      this.templates.set(id, {
        ...template,
        _count: { mailings: template._count.mailings + delta },
      });
    }
  }
}

/**
 * Диспетчер, обрабатывающий задачи **сразу**, в том же запросе.
 *
 * Так вся цепочка «отправил → доставилось → видно в строке получателя»
 * проходится по настоящему HTTP-пути, не поднимая Redis. Единственное, чего
 * этот набор не проверяет, — сам BullMQ: он проверяется в `health.e2e-spec.ts`,
 * где приложение поднимается целиком против настоящего Redis.
 */
class SyncDispatcher extends MailingDispatcher {
  delivery: MailingDeliveryService | null = null;
  /** Последняя ли это попытка — им управляют тесты про повторы. */
  lastAttempt = true;
  readonly enqueued: string[] = [];

  async enqueue(notificationIds: readonly string[]): Promise<void> {
    this.enqueued.push(...notificationIds);

    for (const id of notificationIds) {
      await this.delivery?.deliver(id, this.lastAttempt);
    }
  }
}

/** Отправитель, которым управляют тесты: считает вызовы и умеет отказывать. */
class FakeSender extends MessageSender {
  readonly sent: { channel: MessageChannel; address: string; title: string; body: string }[] = [];
  failWith: Error | null = null;

  send(message: {
    channel: MessageChannel;
    address: string;
    title: string;
    body: string;
  }): Promise<void> {
    if (this.failWith !== null) return Promise.reject(this.failWith);

    this.sent.push(message);

    return Promise.resolve();
  }
}

const ALL_CODES = [
  'Permission.Mailings.Views',
  'Permission.Mailings.Create',
  'Permission.Mailings.Update',
  'Permission.Mailings.Delete',
  'Permission.Mailings.Send',
  'Permission.Mailings.ManageTemplates',
];

const person = (over: Partial<RecipientRow> = {}): RecipientRow => ({
  id: randomUUID(),
  firstName: 'Умед',
  lastName: 'Раҳимов',
  telegram: '@umed',
  phone: '+992900000001',
  email: 'umed@omuz.tj',
  ...over,
});

describe('Рассылки и шаблоны (ТЗ 5.19)', () => {
  let app: INestApplication;
  let tokens: TokenService;
  const rbac = new InMemoryRbacRepository();
  const store = new InMemoryStore();
  const dispatcher = new SyncDispatcher();
  const sender = new FakeSender();

  beforeEach(async () => {
    store.reset();
    dispatcher.enqueued.length = 0;
    dispatcher.lastAttempt = true;
    sender.sent.length = 0;
    sender.failWith = null;

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        MessagingModule,
        PhoneModule,
        RateLimitModule,
        AuthModule,
        RbacModule,
        MailingsModule,
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
      .overrideProvider(MailingsRepository)
      .useValue(store)
      .overrideProvider(MailingDispatcher)
      .useValue(dispatcher)
      .overrideProvider(MessageSender)
      .useValue(sender)
      .compile();

    tokens = moduleRef.get(TokenService, { strict: false });
    dispatcher.delivery = moduleRef.get(MailingDeliveryService, { strict: false });

    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  const actor = async (codes: string[] = ALL_CODES): Promise<string> => {
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

  /** Черновик рассылки настоящим запросом — так же, как его заводит оператор. */
  const draft = async (
    token: string,
    body: Record<string, unknown> = {},
  ): Promise<{ id: string }> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/mailings')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Занятия',
        body: 'Перенос на 14:00',
        channel: MessageChannel.TELEGRAM,
        audience: MailingAudience.STUDENTS,
        ...body,
      })
      .expect(201);

    return dataOf<{ id: string }>(response);
  };

  // --- Шаблоны --------------------------------------------------------

  describe('шаблоны', () => {
    it('заводит шаблон и отдаёт его в списке', async () => {
      const token = await actor();

      await request(app.getHttpServer())
        .post('/api/v1/mailings/templates')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Оплата', title: 'Оплата обучения', body: 'Внесите до 5 числа' })
        .expect(201);

      const list = await request(app.getHttpServer())
        .get('/api/v1/mailings/templates')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(dataOf<{ name: string; channel: null }[]>(list)).toHaveLength(1);
      expect(dataOf<{ channel: null }[]>(list)[0]?.channel).toBeNull();
    });

    it('тёзка без учёта регистра — 409', async () => {
      const token = await actor();
      const create = { name: 'Оплата', title: 'З', body: 'Т' };

      await request(app.getHttpServer())
        .post('/api/v1/mailings/templates')
        .set('Authorization', `Bearer ${token}`)
        .send(create)
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/mailings/templates')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...create, name: 'оПлАтА' })
        .expect(409);
    });

    it('пустая строка в канале снимает привязку, а мусор — 400', async () => {
      const token = await actor();

      const created = await request(app.getHttpServer())
        .post('/api/v1/mailings/templates')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Оплата', title: 'З', body: 'Т', channel: MessageChannel.SMS })
        .expect(201);

      const id = dataOf<{ id: string }>(created).id;

      const cleared = await request(app.getHttpServer())
        .put(`/api/v1/mailings/templates/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ channel: '' })
        .expect(200);

      expect(dataOf<{ channel: null }>(cleared).channel).toBeNull();

      await request(app.getHttpServer())
        .put(`/api/v1/mailings/templates/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ channel: 'WHATSAPP' })
        .expect(400);
    });

    it('фильтр по каналу отбирает и шаблоны без канала', async () => {
      const token = await actor();

      for (const [name, channel] of [
        ['Смс-шаблон', MessageChannel.SMS],
        ['Телеграм-шаблон', MessageChannel.TELEGRAM],
        ['Общий', ''],
      ] as const) {
        await request(app.getHttpServer())
          .post('/api/v1/mailings/templates')
          .set('Authorization', `Bearer ${token}`)
          .send({ name, title: 'З', body: 'Т', ...(channel === '' ? {} : { channel }) })
          .expect(201);
      }

      const list = await request(app.getHttpServer())
        .get('/api/v1/mailings/templates?channel=SMS')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(
        dataOf<{ name: string }[]>(list)
          .map((row) => row.name)
          .sort(),
      ).toEqual(['Общий', 'Смс-шаблон']);
    });

    it('шаблон подставляет текст в рассылку снимком, и правка его не переписывает', async () => {
      const token = await actor();

      const template = dataOf<{ id: string }>(
        await request(app.getHttpServer())
          .post('/api/v1/mailings/templates')
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Оплата', title: 'Оплата обучения', body: 'Внесите до 5 числа' })
          .expect(201),
      );

      const mailing = dataOf<{ id: string; title: string; body: string }>(
        await request(app.getHttpServer())
          .post('/api/v1/mailings')
          .set('Authorization', `Bearer ${token}`)
          .send({
            channel: MessageChannel.SMS,
            audience: MailingAudience.STUDENTS,
            templateId: template.id,
          })
          .expect(201),
      );

      expect(mailing).toMatchObject({ title: 'Оплата обучения', body: 'Внесите до 5 числа' });

      await request(app.getHttpServer())
        .put(`/api/v1/mailings/templates/${template.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ body: 'Совсем другой текст' })
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/api/v1/mailings/${mailing.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(dataOf<{ body: string }>(after).body).toBe('Внесите до 5 числа');
    });

    it('использованный шаблон удаляется — рассылка теряет только указатель на источник', async () => {
      const token = await actor();

      const template = dataOf<{ id: string }>(
        await request(app.getHttpServer())
          .post('/api/v1/mailings/templates')
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Оплата', title: 'Оплата обучения', body: 'Внесите до 5 числа' })
          .expect(201),
      );

      const mailing = await draft(token, { templateId: template.id });

      await request(app.getHttpServer())
        .delete(`/api/v1/mailings/templates/${template.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/api/v1/mailings/${mailing.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(dataOf<{ template: null; body: string }>(after)).toMatchObject({
        template: null,
        body: 'Перенос на 14:00',
      });
    });

    it('`/mailings/templates` не попадает в карточку рассылки', async () => {
      const token = await actor();

      // Если бы контроллер шаблонов объявлялся вторым, путь ушёл бы
      // в `/mailings/{id}` и вернулся бы 400 «не UUID».
      await request(app.getHttpServer())
        .get('/api/v1/mailings/templates')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });
  });

  // --- Составление ----------------------------------------------------

  describe('составление', () => {
    it('без шаблона требует и заголовок, и текст — 422', async () => {
      const token = await actor();

      await request(app.getHttpServer())
        .post('/api/v1/mailings')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Только заголовок',
          channel: MessageChannel.SMS,
          audience: MailingAudience.STUDENTS,
        })
        .expect(422);
    });

    it('аудитория GROUP без группы — 422, а с группой — 201', async () => {
      const token = await actor();
      store.groups.set('11111111-1111-4111-8111-111111111111', {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Frontend-1',
      });

      await request(app.getHttpServer())
        .post('/api/v1/mailings')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'З',
          body: 'Т',
          channel: MessageChannel.SMS,
          audience: MailingAudience.GROUP,
        })
        .expect(422);

      const created = await draft(token, {
        audience: MailingAudience.GROUP,
        groupId: '11111111-1111-4111-8111-111111111111',
      });

      const card = await request(app.getHttpServer())
        .get(`/api/v1/mailings/${created.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(dataOf<{ group: { name: string } }>(card).group.name).toBe('Frontend-1');
    });

    it('группа у аудитории «все студенты» — 422: это отбор, которого не будет', async () => {
      const token = await actor();

      await request(app.getHttpServer())
        .post('/api/v1/mailings')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'З',
          body: 'Т',
          channel: MessageChannel.SMS,
          audience: MailingAudience.STUDENTS,
          groupId: '11111111-1111-4111-8111-111111111111',
        })
        .expect(422);
    });

    it('новый черновик отдаётся со статусом DRAFT и нулевыми счётчиками', async () => {
      const token = await actor();
      const created = await draft(token);

      const card = await request(app.getHttpServer())
        .get(`/api/v1/mailings/${created.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(dataOf<Record<string, unknown>>(card)).toMatchObject({
        status: 'DRAFT',
        sentAt: null,
        deliveries: { total: 0, pending: 0, sent: 0, failed: 0, skipped: 0 },
      });
    });

    it('текст длиннее потолка — 400', async () => {
      const token = await actor();

      await request(app.getHttpServer())
        .post('/api/v1/mailings')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'З',
          body: 'я'.repeat(2001),
          channel: MessageChannel.SMS,
          audience: MailingAudience.STUDENTS,
        })
        .expect(400);
    });
  });

  // --- Отправка -------------------------------------------------------

  describe('отправка', () => {
    it('главное свойство: составил → отправил → сообщение ушло получателям', async () => {
      const token = await actor();
      store.activeStudents = [
        person({ firstName: 'Умед', telegram: '@umed' }),
        person({ firstName: 'Нигина', telegram: '@nigina' }),
      ];

      const created = await draft(token);

      const sent = await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/send`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      expect(dataOf<{ queued: number }>(sent).queued).toBe(2);
      expect(sender.sent.map((message) => message.address).sort()).toEqual(['@nigina', '@umed']);
      // Текст берётся из рассылки, а не из шаблона и не собирается заново.
      expect(sender.sent[0]).toMatchObject({
        channel: MessageChannel.TELEGRAM,
        title: 'Занятия',
        body: 'Перенос на 14:00',
      });

      const card = await request(app.getHttpServer())
        .get(`/api/v1/mailings/${created.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(dataOf<Record<string, unknown>>(card)).toMatchObject({
        status: 'SENT',
        deliveries: { total: 2, pending: 0, sent: 2, failed: 0, skipped: 0 },
      });
    });

    it('«дошло ли до конкретного человека» — на это отвечает список доставок', async () => {
      const token = await actor();
      const umed = person({ firstName: 'Умед', lastName: 'Раҳимов' });
      store.activeStudents = [umed];

      const created = await draft(token);
      await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/send`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      const recipients = await request(app.getHttpServer())
        .get(`/api/v1/mailings/${created.id}/recipients`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(dataOf<Record<string, unknown>[]>(recipients)[0]).toMatchObject({
        recipientName: 'Умед Раҳимов',
        recipientType: 'STUDENT',
        recipientId: umed.id,
        address: '@umed',
        status: 'SENT',
        attempts: 1,
      });
      expect(metaOf<{ deliveries: { sent: number } }>(recipients).deliveries.sent).toBe(1);
    });

    it('получатель без адреса канала виден строкой SKIPPED с причиной, а не пропадает', async () => {
      const token = await actor();
      store.activeStudents = [
        person({ firstName: 'Умед', telegram: '@umed' }),
        person({ firstName: 'Далер', telegram: null }),
      ];

      const created = await draft(token);

      const sent = await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/send`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      // Счётчики в ответе `send` — состояние **на момент постановки в очередь**:
      // один получатель ушёл в очередь (`pending`), второму отправлять некуда
      // (`skipped`). Что из очереди вышло, показывает карточка ниже.
      expect(dataOf<Record<string, unknown>>(sent)).toMatchObject({
        queued: 1,
        deliveries: { total: 2, sent: 0, pending: 1, skipped: 1 },
      });
      expect(sender.sent).toHaveLength(1);

      const skipped = await request(app.getHttpServer())
        .get(`/api/v1/mailings/${created.id}/recipients?status=SKIPPED`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(dataOf<{ recipientName: string; error: string }[]>(skipped)[0]).toMatchObject({
        recipientName: 'Далер Раҳимов',
        error: 'Адрес канала у получателя не указан',
      });

      // Дошло не до всех — значит рассылка частичная, а не «отправлена».
      const card = await request(app.getHttpServer())
        .get(`/api/v1/mailings/${created.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(dataOf<{ status: string }>(card).status).toBe('PARTIAL');
    });

    it('канал определяет адрес: у SMS-рассылки уходит телефон', async () => {
      const token = await actor();
      store.activeStudents = [person({ phone: '+992900000009', telegram: null })];

      const created = await draft(token, { channel: MessageChannel.SMS });
      await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/send`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      expect(sender.sent[0]?.address).toBe('+992900000009');
    });

    it('аудитория GROUP берёт состав своей группы, а не всех студентов', async () => {
      const token = await actor();
      const groupId = '22222222-2222-4222-8222-222222222222';
      store.groups.set(groupId, { id: groupId, name: 'Frontend-1' });
      store.groupStudents.set(groupId, [person({ telegram: '@group-student' })]);
      store.activeStudents = [person({ telegram: '@somebody-else' })];

      const created = await draft(token, { audience: MailingAudience.GROUP, groupId });
      await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/send`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      expect(sender.sent.map((message) => message.address)).toEqual(['@group-student']);
    });

    it('ментору пишут как сотруднику, лиду — как обращению', async () => {
      const token = await actor();
      const mentor = person({ telegram: '@mentor' });
      const lead = person({ telegram: '@lead' });
      store.mentors = [mentor];
      store.leads = [lead];

      for (const [audience, id, type] of [
        [MailingAudience.MENTORS, mentor.id, 'EMPLOYEE'],
        [MailingAudience.LEADS, lead.id, 'LEAD'],
      ] as const) {
        const created = await draft(token, { audience });
        await request(app.getHttpServer())
          .post(`/api/v1/mailings/${created.id}/send`)
          .set('Authorization', `Bearer ${token}`)
          .expect(202);

        const recipients = await request(app.getHttpServer())
          .get(`/api/v1/mailings/${created.id}/recipients`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

        expect(
          dataOf<{ recipientType: string; recipientId: string }[]>(recipients)[0],
        ).toMatchObject({ recipientType: type, recipientId: id });
      }
    });

    it('пустая аудитория — 422, и ничего не записывается', async () => {
      const token = await actor();
      const created = await draft(token);

      await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/send`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);

      const card = await request(app.getHttpServer())
        .get(`/api/v1/mailings/${created.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(dataOf<{ status: string }>(card).status).toBe('DRAFT');
      expect(store.notifications.size).toBe(0);
    });

    it('повторная отправка — 422: отменить второе сообщение было бы нечем', async () => {
      const token = await actor();
      store.activeStudents = [person()];

      const created = await draft(token);
      await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/send`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/send`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);

      expect(sender.sent).toHaveLength(1);
    });

    it('отправленную рассылку не править и не удалить', async () => {
      const token = await actor();
      store.activeStudents = [person()];

      const created = await draft(token);
      await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/send`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      await request(app.getHttpServer())
        .put(`/api/v1/mailings/${created.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ body: 'Задним числом' })
        .expect(422);

      await request(app.getHttpServer())
        .delete(`/api/v1/mailings/${created.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);
    });

    it('черновик удаляется', async () => {
      const token = await actor();
      const created = await draft(token);

      await request(app.getHttpServer())
        .delete(`/api/v1/mailings/${created.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      await request(app.getHttpServer())
        .get(`/api/v1/mailings/${created.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });

  // --- Отказы и повтор ------------------------------------------------

  describe('отказы и повтор', () => {
    it('отказ провайдера на последней попытке помечает доставку упавшей', async () => {
      const token = await actor();
      store.activeStudents = [person()];
      sender.failWith = new Error('провайдер недоступен');

      const created = await draft(token);
      await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/send`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      const card = await request(app.getHttpServer())
        .get(`/api/v1/mailings/${created.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(dataOf<Record<string, unknown>>(card)).toMatchObject({
        status: 'FAILED',
        deliveries: { total: 1, failed: 1, sent: 0 },
      });
    });

    it('повтор упавших доводит рассылку до SENT, не рассылая всем заново', async () => {
      const token = await actor();
      store.activeStudents = [person({ telegram: '@umed' }), person({ telegram: '@nigina' })];
      sender.failWith = new Error('провайдер недоступен');

      const created = await draft(token);
      await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/send`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      expect(sender.sent).toHaveLength(0);

      sender.failWith = null;

      const retried = await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/retry`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      expect(dataOf<{ queued: number }>(retried).queued).toBe(2);
      expect(sender.sent).toHaveLength(2);

      const card = await request(app.getHttpServer())
        .get(`/api/v1/mailings/${created.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(dataOf<{ status: string }>(card).status).toBe('SENT');
    });

    it('повтор не трогает доставленных: второго сообщения они не получают', async () => {
      const token = await actor();
      const good = person({ telegram: '@umed' });
      const bad = person({ telegram: '@nigina' });
      store.activeStudents = [good, bad];

      const created = await draft(token);
      // Первый уходит, второй падает: отправитель отказывает начиная со второго.
      let call = 0;
      const original = sender.send.bind(sender);
      jest.spyOn(sender, 'send').mockImplementation((message) => {
        call += 1;

        return call === 1 ? original(message) : Promise.reject(new Error('таймаут'));
      });

      await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/send`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      jest.restoreAllMocks();

      const retried = await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/retry`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      // Повторяется ровно одна упавшая доставка, а не обе.
      expect(dataOf<{ queued: number }>(retried).queued).toBe(1);
    });

    it('повтор вытаскивает зависшую доставку: приложение упало между записью и очередью', async () => {
      const token = await actor();
      store.activeStudents = [person()];
      // Постановка задач падает после фиксации транзакции — строка остаётся
      // `PENDING`, и без `retry` она висела бы так навсегда.
      const broken = jest
        .spyOn(dispatcher, 'enqueue')
        .mockRejectedValueOnce(new Error('Redis недоступен'));

      const created = await draft(token);
      await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/send`)
        .set('Authorization', `Bearer ${token}`)
        .expect(500);

      broken.mockRestore();

      const stuck = await request(app.getHttpServer())
        .get(`/api/v1/mailings/${created.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(dataOf<{ status: string }>(stuck).status).toBe('SENDING');

      const retried = await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/retry`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      expect(dataOf<{ queued: number }>(retried).queued).toBe(1);
      expect(sender.sent).toHaveLength(1);

      const after = await request(app.getHttpServer())
        .get(`/api/v1/mailings/${created.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(dataOf<{ status: string }>(after).status).toBe('SENT');
    });

    it('повтор не берёт пропущенных без адреса — повторять нечего, пока его не заполнят', async () => {
      const token = await actor();
      store.activeStudents = [person({ telegram: null })];

      const created = await draft(token);
      await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/send`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      const retried = await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/retry`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      expect(dataOf<{ queued: number }>(retried).queued).toBe(0);
    });

    it('неотправленную рассылку повторять нечего — 422', async () => {
      const token = await actor();
      const created = await draft(token);

      await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/retry`)
        .set('Authorization', `Bearer ${token}`)
        .expect(422);
    });

    it('до последней попытки доставка остаётся в очереди, а рассылка — SENDING', async () => {
      const token = await actor();
      store.activeStudents = [person()];
      sender.failWith = new Error('провайдер недоступен');
      dispatcher.lastAttempt = false;

      const created = await draft(token);
      await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/send`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      const card = await request(app.getHttpServer())
        .get(`/api/v1/mailings/${created.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(dataOf<Record<string, unknown>>(card)).toMatchObject({
        status: 'SENDING',
        deliveries: { pending: 1, failed: 0 },
      });
    });
  });

  // --- Список и история -----------------------------------------------

  describe('список и история', () => {
    it('история отдаёт только отправленные, что бы ни стояло в фильтре', async () => {
      const token = await actor();
      store.activeStudents = [person()];

      const sentOne = await draft(token, { title: 'Отправленная' });
      await draft(token, { title: 'Черновик' });

      await request(app.getHttpServer())
        .post(`/api/v1/mailings/${sentOne.id}/send`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      const list = await request(app.getHttpServer())
        .get('/api/v1/mailings')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(dataOf<unknown[]>(list)).toHaveLength(2);

      const history = await request(app.getHttpServer())
        .get('/api/v1/mailings/history?sent=false')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(dataOf<{ title: string }[]>(history).map((row) => row.title)).toEqual([
        'Отправленная',
      ]);
    });

    it('фильтр `sent=false` оставляет только черновики', async () => {
      const token = await actor();
      store.activeStudents = [person()];

      const sentOne = await draft(token, { title: 'Отправленная' });
      await draft(token, { title: 'Черновик' });
      await request(app.getHttpServer())
        .post(`/api/v1/mailings/${sentOne.id}/send`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      const drafts = await request(app.getHttpServer())
        .get('/api/v1/mailings?sent=false')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(dataOf<{ title: string }[]>(drafts).map((row) => row.title)).toEqual(['Черновик']);
    });

    it('поиск идёт по заголовку и тексту', async () => {
      const token = await actor();
      await draft(token, { title: 'Про оплату', body: 'Внесите до пятого' });
      await draft(token, { title: 'Про занятия', body: 'Перенос' });

      const found = await request(app.getHttpServer())
        .get('/api/v1/mailings?search=пятого')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(dataOf<{ title: string }[]>(found).map((row) => row.title)).toEqual(['Про оплату']);
    });

    it('пагинация работает и считает общее число', async () => {
      const token = await actor();
      await draft(token, { title: 'Первая' });
      await draft(token, { title: 'Вторая' });

      const page = await request(app.getHttpServer())
        .get('/api/v1/mailings?page=2&limit=1')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(dataOf<unknown[]>(page)).toHaveLength(1);
      expect(metaOf<{ total: number; totalPages: number }>(page)).toMatchObject({
        total: 2,
        totalPages: 2,
      });
    });
  });

  // --- Доступ ---------------------------------------------------------

  describe('доступ', () => {
    it('без токена — 401', async () => {
      await request(app.getHttpServer()).get('/api/v1/mailings').expect(401);
    });

    it('студенту — 403: рассылки ведут сотрудники', async () => {
      const token = await studentToken();

      await request(app.getHttpServer())
        .get('/api/v1/mailings')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('сотруднику без прав — 403', async () => {
      const token = await actor([]);

      await request(app.getHttpServer())
        .get('/api/v1/mailings')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('право на просмотр НЕ даёт отправлять', async () => {
      const token = await actor(['Permission.Mailings.Views', 'Permission.Mailings.Create']);
      store.activeStudents = [person()];
      const created = await draft(token);

      await request(app.getHttpServer())
        .post(`/api/v1/mailings/${created.id}/send`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      expect(sender.sent).toHaveLength(0);
    });

    it('право на рассылки НЕ даёт вести шаблоны', async () => {
      const token = await actor([
        'Permission.Mailings.Views',
        'Permission.Mailings.Create',
        'Permission.Mailings.Send',
      ]);

      await request(app.getHttpServer())
        .post('/api/v1/mailings/templates')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Оплата', title: 'З', body: 'Т' })
        .expect(403);

      // Читать шаблоны при этом можно: это общий просмотр раздела.
      await request(app.getHttpServer())
        .get('/api/v1/mailings/templates')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('право на отправку НЕ даёт удалять черновики', async () => {
      const token = await actor([
        'Permission.Mailings.Views',
        'Permission.Mailings.Create',
        'Permission.Mailings.Send',
      ]);
      const created = await draft(token);

      await request(app.getHttpServer())
        .delete(`/api/v1/mailings/${created.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });

  // --- Ошибки и документ ----------------------------------------------

  describe('валидация и OpenAPI', () => {
    it('не-UUID в пути — 400', async () => {
      const token = await actor();

      await request(app.getHttpServer())
        .get('/api/v1/mailings/не-uuid')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('неизвестная аудитория — 400', async () => {
      const token = await actor();

      await request(app.getHttpServer())
        .post('/api/v1/mailings')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'З',
          body: 'Т',
          channel: MessageChannel.SMS,
          audience: 'EVERYONE',
        })
        .expect(400);
    });

    it('лишнее поле в теле — 400 (forbidNonWhitelisted)', async () => {
      const token = await actor();

      await request(app.getHttpServer())
        .post('/api/v1/mailings')
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'З',
          body: 'Т',
          channel: MessageChannel.SMS,
          audience: MailingAudience.STUDENTS,
          sentAt: '2026-08-01',
        })
        .expect(400);
    });

    it('все маршруты ТЗ 5.19 есть в документе', () => {
      const document = buildOpenApiDocument(app);

      for (const path of [
        '/api/v1/mailings',
        '/api/v1/mailings/history',
        '/api/v1/mailings/{id}',
        '/api/v1/mailings/templates',
        '/api/v1/mailings/templates/{id}',
      ]) {
        expect(document.paths?.[path]).toBeDefined();
      }
    });

    it('у истории описан только `get`: она ничего не меняет', () => {
      const document = buildOpenApiDocument(app);
      const history = document.paths?.['/api/v1/mailings/history'];

      expect(Object.keys(history ?? {})).toEqual(['get']);
    });

    it('отправка отвечает 202, а не 200: доставка идёт фоном', () => {
      const document = buildOpenApiDocument(app);
      const send = document.paths?.['/api/v1/mailings/{id}/send']?.post;

      expect(Object.keys(send?.responses ?? {})).toContain('202');
    });
  });
});
