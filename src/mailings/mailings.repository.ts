import { Injectable } from '@nestjs/common';
import type {
  DirectoryStatus,
  MailingAudience,
  MessageChannel,
  NotificationRecipientType,
  NotificationStatus,
  Prisma,
} from '@prisma/client';
import { GroupStatus, GroupStudentStatus, StudentStatus } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { MailingSortField, TemplateSortField } from './dto';

/** Шаблон в том виде, в каком его показывает список и карточка (ТЗ 5.19). */
const TEMPLATE_SELECT = {
  id: true,
  name: true,
  title: true,
  body: true,
  channel: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, firstName: true, lastName: true } },
  _count: { select: { mailings: true } },
} satisfies Prisma.SmsTemplateSelect;

export type TemplateRow = Prisma.SmsTemplateGetPayload<{ select: typeof TEMPLATE_SELECT }>;

/**
 * Строка рассылки. Счётчиков доставок здесь нет: они считаются отдельным
 * `groupBy` на всю страницу разом — вложенный `_count` по статусам потребовал бы
 * пяти условных счётчиков на строку, а Prisma такого не выражает.
 */
const MAILING_SELECT = {
  id: true,
  title: true,
  body: true,
  channel: true,
  audience: true,
  sentAt: true,
  createdAt: true,
  updatedAt: true,
  group: { select: { id: true, name: true } },
  template: { select: { id: true, name: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
  sentBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.MailingSelect;

export type MailingRow = Prisma.MailingGetPayload<{ select: typeof MAILING_SELECT }>;

/** Строка доставки — «дошло ли до этого человека» (ТЗ 4: `Notification`). */
const NOTIFICATION_SELECT = {
  id: true,
  channel: true,
  recipientType: true,
  recipientName: true,
  address: true,
  studentId: true,
  employeeId: true,
  leadId: true,
  status: true,
  error: true,
  attempts: true,
  sentAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

export type NotificationRow = Prisma.NotificationGetPayload<{
  select: typeof NOTIFICATION_SELECT;
}>;

/** Доставка вместе с текстом рассылки — всё, что нужно обработчику очереди. */
const DELIVERY_SELECT = {
  id: true,
  channel: true,
  address: true,
  status: true,
  attempts: true,
  // Персональный текст доставки (`null` — брать общий из рассылки).
  body: true,
  mailing: { select: { id: true, title: true, body: true } },
} satisfies Prisma.NotificationSelect;

export type DeliveryRow = Prisma.NotificationGetPayload<{ select: typeof DELIVERY_SELECT }>;

/**
 * Человек, которому уходит сообщение. Один тип на все пять аудиторий: студент,
 * сотрудник и лид отличаются тем, какая ссылка ведёт на профиль, а не составом
 * контактов, — и выбор адреса под канал (`addressFor`) обязан быть один
 * на всех, иначе «нет телеграма» означало бы разное в разных аудиториях.
 */
export interface RecipientRow {
  id: string;
  firstName: string;
  lastName: string;
  telegram: string | null;
  phone: string | null;
  email: string | null;
}

/** Контакты, из которых собирается адрес, — общий `select` трёх выборок. */
const RECIPIENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  telegram: true,
  phone: true,
  email: true,
} as const;

export interface TemplateListParams {
  search?: string;
  status?: DirectoryStatus;
  channel?: MessageChannel;
  sort: TemplateSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface TemplateWriteInput {
  name: string;
  title: string;
  body: string;
  channel: MessageChannel | null;
  status?: DirectoryStatus;
  createdById?: string | null;
}

export type TemplateUpdateInput = Partial<Omit<TemplateWriteInput, 'createdById'>>;

export interface MailingListParams {
  search?: string;
  audience?: MailingAudience;
  channel?: MessageChannel;
  groupId?: string;
  /** Автор рассылки — под список «свои рассылки» кабинета ментора (ТЗ 5.4). */
  createdById?: string;
  /** `true` — только отправленные, `false` — только черновики. */
  sent?: boolean;
  sort: MailingSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface MailingWriteInput {
  title: string;
  body: string;
  channel: MessageChannel;
  audience: MailingAudience;
  groupId: string | null;
  templateId: string | null;
  createdById?: string | null;
}

export type MailingUpdateInput = Partial<Omit<MailingWriteInput, 'createdById'>>;

/** Заготовка строки доставки — собирается сервисом до записи. */
export interface NotificationSeed {
  id: string;
  channel: MessageChannel;
  recipientType: NotificationRecipientType;
  recipientName: string;
  address: string;
  /** Персональный текст после подстановки; `null` — брать общий из рассылки. */
  body: string | null;
  studentId: string | null;
  employeeId: string | null;
  leadId: string | null;
  status: NotificationStatus;
  error: string | null;
}

/** Сколько доставок рассылки в каждом статусе. */
export interface DeliveryCountRow {
  mailingId: string;
  status: NotificationStatus;
  count: number;
}

const templateWhereOf = (params: TemplateListParams): Prisma.SmsTemplateWhereInput => {
  const conditions: Prisma.SmsTemplateWhereInput[] = [];

  if (params.status !== undefined) conditions.push({ status: params.status });
  // Шаблон без канала годится любому — как купон с пустым набором курсов
  // действует на все (0027). Поэтому фильтр отбирает и его тоже.
  if (params.channel !== undefined) {
    conditions.push({ OR: [{ channel: params.channel }, { channel: null }] });
  }

  if (params.search !== undefined) {
    conditions.push({
      OR: [
        { name: { contains: params.search, mode: 'insensitive' } },
        { title: { contains: params.search, mode: 'insensitive' } },
        { body: { contains: params.search, mode: 'insensitive' } },
      ],
    });
  }

  return conditions.length === 0 ? {} : { AND: conditions };
};

const mailingWhereOf = (params: MailingListParams): Prisma.MailingWhereInput => {
  const conditions: Prisma.MailingWhereInput[] = [];

  if (params.audience !== undefined) conditions.push({ audience: params.audience });
  if (params.channel !== undefined) conditions.push({ channel: params.channel });
  if (params.groupId !== undefined) conditions.push({ groupId: params.groupId });
  if (params.createdById !== undefined) conditions.push({ createdById: params.createdById });
  if (params.sent !== undefined) {
    conditions.push(params.sent ? { sentAt: { not: null } } : { sentAt: null });
  }

  if (params.search !== undefined) {
    conditions.push({
      OR: [
        { title: { contains: params.search, mode: 'insensitive' } },
        { body: { contains: params.search, mode: 'insensitive' } },
      ],
    });
  }

  return conditions.length === 0 ? {} : { AND: conditions };
};

/**
 * Доступ к данным рассылок, шаблонов и доставок
 * (`Controller → Service → Repository`).
 *
 * Бизнес-правил здесь нет: состояние рассылки, выбор адреса под канал
 * и потолок аудитории считает сервис чистыми функциями `mailings.ts`.
 */
@Injectable()
export class MailingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // --- Шаблоны (ТЗ 5.19) ------------------------------------------------

  async findTemplates(params: TemplateListParams): Promise<{ rows: TemplateRow[]; total: number }> {
    const where = templateWhereOf(params);

    const orderBy: Prisma.SmsTemplateOrderByWithRelationInput =
      params.sort === TemplateSortField.Title
        ? { title: params.order }
        : params.sort === TemplateSortField.CreatedAt
          ? { createdAt: params.order }
          : { name: params.order };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.smsTemplate.findMany({
        where,
        select: TEMPLATE_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.smsTemplate.count({ where }),
    ]);

    return { rows, total };
  }

  findTemplateById(id: string): Promise<TemplateRow | null> {
    return this.prisma.smsTemplate.findUnique({ where: { id }, select: TEMPLATE_SELECT });
  }

  /** Тёзка без учёта регистра: уникальный индекс регистр учитывает, человек — нет. */
  findTemplateByName(name: string): Promise<{ id: string; name: string } | null> {
    return this.prisma.smsTemplate.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
  }

  createTemplate(input: TemplateWriteInput): Promise<TemplateRow> {
    return this.prisma.smsTemplate.create({ data: input, select: TEMPLATE_SELECT });
  }

  updateTemplate(id: string, input: TemplateUpdateInput): Promise<TemplateRow> {
    return this.prisma.smsTemplate.update({ where: { id }, data: input, select: TEMPLATE_SELECT });
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.prisma.smsTemplate.delete({ where: { id } });
  }

  // --- Рассылки (ТЗ 5.19) -----------------------------------------------

  async findMailings(params: MailingListParams): Promise<{ rows: MailingRow[]; total: number }> {
    const where = mailingWhereOf(params);

    const orderBy: Prisma.MailingOrderByWithRelationInput =
      params.sort === MailingSortField.Title
        ? { title: params.order }
        : params.sort === MailingSortField.SentAt
          ? // Черновик не «самый ранний» и не «самый поздний»: пустая дата
            // уезжает в конец при любом направлении (приём 0007, 0026, 0027).
            { sentAt: { sort: params.order, nulls: 'last' } }
          : { createdAt: params.order };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.mailing.findMany({
        where,
        select: MAILING_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.mailing.count({ where }),
    ]);

    return { rows, total };
  }

  findMailingById(id: string): Promise<MailingRow | null> {
    return this.prisma.mailing.findUnique({ where: { id }, select: MAILING_SELECT });
  }

  createMailing(input: MailingWriteInput): Promise<MailingRow> {
    return this.prisma.mailing.create({ data: input, select: MAILING_SELECT });
  }

  updateMailing(id: string, input: MailingUpdateInput): Promise<MailingRow> {
    return this.prisma.mailing.update({ where: { id }, data: input, select: MAILING_SELECT });
  }

  async deleteMailing(id: string): Promise<void> {
    await this.prisma.mailing.delete({ where: { id } });
  }

  /** Существует ли группа — проверяется своим запросом, как у выпускников (0026). */
  findGroup(id: string): Promise<{ id: string; name: string } | null> {
    return this.prisma.group.findUnique({ where: { id }, select: { id: true, name: true } });
  }

  /**
   * Ведёт ли сотрудник эту группу — под рассылку ментора своей группе (ТЗ 5.4).
   * Тот же запрос, что у `findAssignment` кабинета ментора (0023): чужую
   * и несуществующую группу различать незачем — ментору отказывают одинаково.
   */
  async isGroupMentor(employeeId: string, groupId: string): Promise<boolean> {
    const found = await this.prisma.groupMentor.findUnique({
      where: { groupId_employeeId: { groupId, employeeId } },
      select: { groupId: true },
    });

    return found !== null;
  }

  // --- Доставки ---------------------------------------------------------

  /**
   * Счётчики доставок сразу по нескольким рассылкам: один `groupBy` на всю
   * страницу списка вместо запроса на строку (приём 0007, 0035).
   */
  async countDeliveriesByMailing(mailingIds: string[]): Promise<DeliveryCountRow[]> {
    if (mailingIds.length === 0) return [];

    const rows = await this.prisma.notification.groupBy({
      by: ['mailingId', 'status'],
      where: { mailingId: { in: mailingIds } },
      _count: { _all: true },
    });

    return rows.map(({ mailingId, status, _count }) => ({
      mailingId,
      status,
      count: _count._all,
    }));
  }

  async findNotifications(params: {
    mailingId: string;
    status?: NotificationStatus;
    search?: string;
    skip: number;
    take: number;
  }): Promise<{ rows: NotificationRow[]; total: number }> {
    const where: Prisma.NotificationWhereInput = {
      mailingId: params.mailingId,
      ...(params.status === undefined ? {} : { status: params.status }),
      ...(params.search === undefined
        ? {}
        : {
            OR: [
              { recipientName: { contains: params.search, mode: 'insensitive' } },
              { address: { contains: params.search, mode: 'insensitive' } },
            ],
          }),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        select: NOTIFICATION_SELECT,
        // Устойчивый порядок: имя, затем идентификатор (приём 0024, 0034) —
        // иначе строки «прыгали» бы между страницами при равных именах.
        orderBy: [{ recipientName: 'asc' }, { id: 'asc' }],
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return { rows, total };
  }

  findDelivery(id: string): Promise<DeliveryRow | null> {
    return this.prisma.notification.findUnique({ where: { id }, select: DELIVERY_SELECT });
  }

  /**
   * Отправка: строки доставки и отметка о том, что рассылка ушла, — **одной
   * транзакцией** (ТЗ 7). Рассылка, помеченная отправленной без строк, стала бы
   * пустой историей, а строки без отметки ушли бы второй раз при повторном
   * нажатии «Send».
   */
  async markSent(params: {
    mailingId: string;
    sentAt: Date;
    sentById: string | null;
    notifications: NotificationSeed[];
  }): Promise<MailingRow> {
    return this.prisma.$transaction(async (tx) => {
      await tx.notification.createMany({
        data: params.notifications.map((seed) => ({ ...seed, mailingId: params.mailingId })),
      });

      return tx.mailing.update({
        where: { id: params.mailingId },
        data: { sentAt: params.sentAt, sentById: params.sentById },
        select: MAILING_SELECT,
      });
    });
  }

  /**
   * Доставки, которые ещё можно довести до конца: упавшие и **зависшие**.
   *
   * `PENDING` попадает сюда не для красоты: между фиксацией транзакции
   * и постановкой задач в очередь приложение может упасть, и тогда строка
   * останется «в очереди», которой её никто не поручал. Без этого условия
   * такая доставка не лечилась бы ничем. Двойной задачи бояться не нужно:
   * обработчик берёт только `PENDING` и после первой же успешной отправки
   * второй заход пропустит.
   *
   * `SKIPPED` не берётся: у этих людей нет адреса, и повторять нечего,
   * пока его не заполнят.
   */
  async findRetryableDeliveryIds(mailingId: string): Promise<string[]> {
    const rows = await this.prisma.notification.findMany({
      where: { mailingId, status: { in: ['FAILED', 'PENDING'] } },
      select: { id: true },
    });

    return rows.map(({ id }) => id);
  }

  /** Возврат доставок в очередь: статус сбрасывается, счётчик попыток — нет. */
  async resetDeliveries(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    await this.prisma.notification.updateMany({
      where: { id: { in: ids } },
      data: { status: 'PENDING', error: null },
    });
  }

  async markDelivered(id: string, attempts: number, sentAt: Date): Promise<void> {
    await this.prisma.notification.update({
      where: { id },
      data: { status: 'SENT', attempts, error: null, sentAt },
    });
  }

  async markDeliveryFailed(id: string, attempts: number, error: string): Promise<void> {
    await this.prisma.notification.update({
      where: { id },
      data: { status: 'FAILED', attempts, error },
    });
  }

  /** Попытка учтена, статус пока не меняется — очередь будет повторять. */
  async registerAttempt(id: string, attempts: number, error: string): Promise<void> {
    await this.prisma.notification.update({ where: { id }, data: { attempts, error } });
  }

  // --- Аудитории (ТЗ 5.19) ----------------------------------------------

  /**
   * Действующий состав группы. Закрытые членства не адресуются: ушедший
   * с курса перестаёт быть его студентом, и рассылка «завтра занятие
   * в 208-й» ему не адресована.
   */
  findGroupStudents(groupId: string): Promise<RecipientRow[]> {
    return this.prisma.student.findMany({
      where: { groups: { some: { groupId, status: GroupStudentStatus.ACTIVE } } },
      select: RECIPIENT_SELECT,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Аудитория «Students» — учащиеся **сейчас**. Заблокированному центр
   * не пишет, а закончившие и ушедшие адресуются аудиторией «Graduates»
   * и витриной оттока: тот же отбор, что у рейтинга (0019) и сводки (0035).
   */
  findActiveStudents(): Promise<RecipientRow[]> {
    return this.prisma.student.findMany({
      where: { status: StudentStatus.ACTIVE },
      select: RECIPIENT_SELECT,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Аудитория «Mentors». Ментор определён **менторством живой группы**,
   * а не названием позиции: правило 0010 (название позиции редактируется,
   * и первое же переименование обнулило бы аудиторию) и ровно тот же запрос,
   * что у счётчика менторов в дашборде (0035).
   */
  findMentors(): Promise<RecipientRow[]> {
    return this.prisma.employee.findMany({
      where: {
        status: 'ACTIVE',
        mentorGroups: {
          some: { group: { status: { in: [GroupStatus.ACTIVE, GroupStatus.RECRUITING] } } },
        },
      },
      select: RECIPIENT_SELECT,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Аудитория «Leads» — обращения, ещё **не переведённые** в студенты (0028).
   * Переведённый уже адресуется как студент, и без этого условия он получил бы
   * рассылку центра дважды: как студент и как лид.
   */
  findLeads(): Promise<RecipientRow[]> {
    return this.prisma.lead.findMany({
      where: { convertedStudentId: null },
      select: RECIPIENT_SELECT,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Аудитория «Graduates» — профили с записью о выпуске (0026). Выпусков
   * у человека бывает несколько (закончив один курс, идёт на следующий),
   * поэтому отбор идёт по студентам, а не по строкам `Graduate`: иначе
   * выпускник двух курсов получил бы два сообщения.
   */
  findGraduates(): Promise<RecipientRow[]> {
    return this.prisma.student.findMany({
      where: { graduations: { some: {} } },
      select: RECIPIENT_SELECT,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    });
  }

  /** Профиль сотрудника, стоящего за токеном (приём 0026, 0029). */
  findEmployeeByAccount(accountId: string): Promise<{ id: string } | null> {
    return this.prisma.employee.findUnique({ where: { accountId }, select: { id: true } });
  }

  // --- Системные рассылки (поздравления с ДР, ТЗ 3.4) -------------------

  /**
   * Системная рассылка вместе со строками доставки — одной транзакцией, как
   * `markSent`. Аудитория `SYSTEM`, автор и отправитель `null` (её завёл
   * не человек), `sentAt` проставляется сразу: черновиком системная рассылка
   * не бывает.
   *
   * `systemKey` уникален, поэтому повторный прогон задачи за ту же дату упадёт
   * с `P2002` — на этом и держится идемпотентность (сервис ловит его и просто
   * ничего не делает). Возвращает `id` заведённой рассылки.
   */
  async createSystemMailing(params: {
    systemKey: string;
    channel: MessageChannel;
    title: string;
    body: string;
    sentAt: Date;
    notifications: NotificationSeed[];
  }): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const mailing = await tx.mailing.create({
        data: {
          title: params.title,
          body: params.body,
          channel: params.channel,
          audience: 'SYSTEM',
          systemKey: params.systemKey,
          sentAt: params.sentAt,
        },
        select: { id: true },
      });

      await tx.notification.createMany({
        data: params.notifications.map((seed) => ({ ...seed, mailingId: mailing.id })),
      });

      return mailing.id;
    });
  }

  /**
   * Действующие студенты, у которых сегодня день рождения (ТЗ 3.4).
   *
   * Сравнение месяца и дня требует `EXTRACT`, которого построитель запросов
   * Prisma не выражает, — отсюда сырой SQL. Дата приходит уже в календаре
   * центра (UTC+5): «сегодня» вычисляет сервис, репозиторий лишь отбирает
   * по паре (месяц, день). Родившиеся 29 февраля в невисокосный год не
   * совпадут ни с чем — редкий край, оставлен как есть.
   */
  findStudentsBornOn(month: number, day: number): Promise<RecipientRow[]> {
    return this.prisma.$queryRaw<RecipientRow[]>`
      SELECT "id", "firstName", "lastName", "telegram", "phone", "email"
      FROM "students"
      WHERE "status" = 'ACTIVE'
        AND "birthDate" IS NOT NULL
        AND EXTRACT(MONTH FROM "birthDate") = ${month}
        AND EXTRACT(DAY FROM "birthDate") = ${day}
      ORDER BY "lastName" ASC, "firstName" ASC, "id" ASC
    `;
  }

  /**
   * Активный шаблон поздравления по зарезервированному имени. Позволяет центру
   * переписать текст через обычный CRUD шаблонов (ТЗ 5.19), не трогая код;
   * если такого шаблона нет, сервис берёт встроенный текст по умолчанию.
   */
  findActiveTemplateByName(
    name: string,
  ): Promise<{ title: string; body: string; channel: MessageChannel | null } | null> {
    return this.prisma.smsTemplate.findFirst({
      where: { status: 'ACTIVE', name: { equals: name, mode: 'insensitive' } },
      select: { title: true, body: true, channel: true },
    });
  }

  /**
   * Зависшие доставки: `PENDING` у **уже отправленной** рассылки, созданные
   * раньше порога. Такая строка означает задачу, которая до очереди не дошла
   * (приложение упало между фиксацией транзакции и `addBulk`, 0036) или в ней
   * потерялась. Порог отсекает свежие доставки, которые просто ещё не успел
   * взять воркер. Возвращаются идентификаторы — их переставит в очередь тот же
   * механизм, что и ручной повтор; обработчик берёт только `PENDING`, поэтому
   * лишняя задача безвредна.
   */
  async findStuckPendingIds(before: Date, limit: number): Promise<string[]> {
    const rows = await this.prisma.notification.findMany({
      where: {
        status: 'PENDING',
        createdAt: { lt: before },
        mailing: { sentAt: { not: null } },
      },
      select: { id: true },
      take: limit,
    });

    return rows.map(({ id }) => id);
  }
}
