import {
  MailingAudience,
  MessageChannel,
  NotificationRecipientType,
  NotificationStatus,
} from '@prisma/client';

/**
 * Правила рассылок (ТЗ 5.19) чистыми функциями.
 *
 * Здесь нет ни Prisma, ни Nest: состояние рассылки, выбор адреса под канал
 * и счётчики доставок — это арифметика и разбор перечислений, и держать их
 * рядом с запросами значило бы проверять их только через HTTP. Тот же приём,
 * что у `dashboard.ts` (0035), `timetable.ts` (0034) и `journal.ts` (0018).
 */

/**
 * Состояние рассылки. **Не хранится в БД**, а выводится из даты отправки
 * и счётчиков доставок (`mailingStatusOf`): колонку пришлось бы пересчитывать
 * после каждой доставки, то есть тысячу раз на одну рассылку, и первый же сбой
 * развёл бы её со строками `Notification`.
 */
export enum MailingStatus {
  /// Составлена, но не отправлена.
  DRAFT = 'DRAFT',
  /// Отправка идёт: часть доставок ещё в очереди.
  SENDING = 'SENDING',
  /// Все доставки завершены и хотя бы одна не удалась.
  PARTIAL = 'PARTIAL',
  /// Не доставлено никому.
  FAILED = 'FAILED',
  /// Доставлено всем.
  SENT = 'SENT',
}

/** Счётчики доставок одной рассылки. */
export interface DeliveryCounts {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
}

/** Нулевые счётчики — состояние черновика, которому ещё никого не считали. */
export const EMPTY_DELIVERY_COUNTS: DeliveryCounts = {
  total: 0,
  pending: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
};

/**
 * Свод строк доставки в счётчики. На вход идёт результат `groupBy` по статусу,
 * а не сами строки: их у рассылки тысячи, а на экране нужно пять чисел.
 */
export const countDeliveries = (
  groups: readonly { status: NotificationStatus; count: number }[],
): DeliveryCounts => {
  const counts: DeliveryCounts = { ...EMPTY_DELIVERY_COUNTS };

  for (const group of groups) {
    counts.total += group.count;

    if (group.status === NotificationStatus.PENDING) counts.pending += group.count;
    else if (group.status === NotificationStatus.SENT) counts.sent += group.count;
    else if (group.status === NotificationStatus.FAILED) counts.failed += group.count;
    else counts.skipped += group.count;
  }

  return counts;
};

/**
 * Состояние рассылки по дате отправки и счётчикам.
 *
 * Порядок проверок и есть содержание правила:
 * 1. нет даты отправки — черновик, счётчики не смотрим вовсе;
 * 2. есть незавершённые доставки — отправка идёт;
 * 3. не ушло **никому** — отказ (в том числе когда у всех получателей
 *    не оказалось адреса: рассылка, не дошедшая ни до кого, не «отправлена»);
 * 4. что-то не ушло — частичная;
 * 5. иначе — доставлено всем.
 *
 * Случай `total === 0` попадает в третью ветку и даёт `FAILED`. На практике
 * его не бывает: отправка на пустую аудиторию отклоняется (422), поэтому
 * у отправленной рассылки всегда есть хотя бы одна строка доставки.
 */
export const mailingStatusOf = (sentAt: Date | null, counts: DeliveryCounts): MailingStatus => {
  if (sentAt === null) return MailingStatus.DRAFT;
  if (counts.pending > 0) return MailingStatus.SENDING;
  if (counts.sent === 0) return MailingStatus.FAILED;
  if (counts.failed + counts.skipped > 0) return MailingStatus.PARTIAL;

  return MailingStatus.SENT;
};

/** Пометка в строке доставки, когда адреса канала у получателя нет. */
export const NO_ADDRESS_REASON = 'Адрес канала у получателя не указан';

/** Контакты получателя в том виде, в каком их читает выбор адреса. */
export interface RecipientContacts {
  telegram: string | null;
  phone: string | null;
  email: string | null;
}

/**
 * Адрес получателя под выбранный канал — или `null`, если его нет.
 *
 * Пустая строка и строка из пробелов считаются отсутствием адреса: колонка
 * `telegram` необязательна, и оператор, стерший её содержимое, оставляет
 * не «адрес из пробелов», а пробел в данных.
 */
export const addressFor = (channel: MessageChannel, contacts: RecipientContacts): string | null => {
  const raw =
    channel === MessageChannel.TELEGRAM
      ? contacts.telegram
      : channel === MessageChannel.SMS
        ? contacts.phone
        : contacts.email;

  if (raw === null) return null;

  const trimmed = raw.trim();

  return trimmed === '' ? null : trimmed;
};

/** Кем получатель приходится центру — по аудитории, из которой он отобран. */
export const recipientTypeOf = (audience: MailingAudience): NotificationRecipientType => {
  if (audience === MailingAudience.MENTORS) return NotificationRecipientType.EMPLOYEE;
  if (audience === MailingAudience.LEADS) return NotificationRecipientType.LEAD;

  // GROUP, STUDENTS и GRADUATES адресуются профилю студента: выпускник —
  // это тот же профиль с записью о выпуске (0026), а не отдельный человек.
  return NotificationRecipientType.STUDENT;
};

/**
 * Требует ли аудитория указания группы. Условная обязательность колонки
 * в Prisma не выражается, поэтому правило живёт здесь — и проверяется
 * с обеих сторон: без группы у `GROUP` и с группой у остальных.
 */
export const audienceNeedsGroup = (audience: MailingAudience): boolean =>
  audience === MailingAudience.GROUP;

/** Имя получателя для строки истории — снимок на момент отправки. */
export const recipientNameOf = (firstName: string, lastName: string): string =>
  `${firstName} ${lastName}`.trim();

/** Переменные, которые подставляются в текст сообщения (ТЗ 3.4). */
export interface MessageVariables {
  firstName: string;
  lastName: string;
}

/** Плейсхолдер `{{ имя }}` — буквы/цифры внутри двойных фигурных скобок. */
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * Подстановка переменных вида `{{firstName}}` в текст рассылки.
 *
 * Нужна ради поздравлений с ДР (ТЗ 3.4): «С днём рождения, {{firstName}}!»
 * без подстановки было бы безличным письмом всем сразу. Отсюда же берёт смысл
 * колонка `Notification.body` — до подстановок текст был один на всех, и копия
 * в каждой строке доставки была бы вторым источником истины (заметка 0036).
 *
 * **Неизвестный плейсхолдер остаётся как есть**, а не превращается в пустоту:
 * `{{firstname}}` с опечаткой должен броситься в глаза составителю, а не молча
 * исчезнуть из письма (то же правило видимого пробела, что у `SKIPPED`, 0036).
 * Практическое следствие, на котором держится хранение: если подставлять
 * нечего, результат **дословно равен** исходному тексту — и тогда персональную
 * копию не заводят.
 */
export const renderMessage = (text: string, vars: MessageVariables): string => {
  const values: Record<string, string> = {
    firstName: vars.firstName,
    lastName: vars.lastName,
    fullName: recipientNameOf(vars.firstName, vars.lastName),
  };

  return text.replace(PLACEHOLDER, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
  );
};

/**
 * Персональный текст для строки доставки — или `null`, если подставлять было
 * нечего. `null`, а не копия исходного текста: обработчик читает `body ?? mailing.body`,
 * поэтому у рассылки без подстановок строки доставки остаются лёгкими, а второй
 * источник истины о тексте не заводится (заметка 0036).
 */
export const personalBodyOf = (template: string, vars: MessageVariables): string | null => {
  const rendered = renderMessage(template, vars);

  return rendered === template ? null : rendered;
};

/**
 * Потолок аудитории одной рассылки. Тот же, что у выгрузки лидов (0028):
 * «отправить всем» не должно означать «поставить в очередь сколько угодно» —
 * строки доставки и задачи очереди создаются по одной на человека.
 *
 * Превышение — отказ (422), а не усечение: молча отправить половине хуже,
 * чем не отправить никому и сказать почему (решения 0019, 0024, 0025, 0029).
 */
export const MAX_MAILING_RECIPIENTS = 5000;
