import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { MessageChannel, NotificationRecipientType } from '@prisma/client';
import { NotificationStatus, Prisma } from '@prisma/client';

import { MailingDispatcher } from './mailing-dispatcher';
import type { DeliveryCounts } from './mailings';
import {
  addressFor,
  countDeliveries,
  EMPTY_DELIVERY_COUNTS,
  NO_ADDRESS_REASON,
  personalBodyOf,
  recipientNameOf,
} from './mailings';
import type { NotificationSeed } from './mailings.repository';
import { MailingsRepository } from './mailings.repository';

/**
 * Получатель системной рассылки. В отличие от аудиторного пути (`seedOf`),
 * вид получателя задаётся **явно**, а не выводится из аудитории: у системной
 * рассылки аудитория одна (`SYSTEM`), а адресатами бывают и студенты
 * (поздравления с ДР), и сотрудники — кем именно приходится человек, знает
 * задача, которая его отобрала.
 */
export interface SystemRecipient {
  recipientType: NotificationRecipientType;
  studentId: string | null;
  employeeId: string | null;
  leadId: string | null;
  firstName: string;
  lastName: string;
  telegram: string | null;
  phone: string | null;
  email: string | null;
}

/** Чем кончилась системная отправка — уходит в лог и в отчёт задачи. */
export interface SystemDispatchResult {
  /** Завела ли эта попытка рассылку (`false` — за этот ключ уже сделано). */
  created: boolean;
  deliveries: DeliveryCounts;
  queued: number;
}

/**
 * Системная отправка — рассылка «от системы», а не от оператора (ТЗ 3.4:
 * поздравления с ДР — частный случай модуля рассылок).
 *
 * Отличий от обычной отправки два, и оба вынужденные:
 *   1. **идемпотентность по ключу** — задача повторяется по расписанию и после
 *      простоя, и второй прогон за ту же дату не должен слать людям второе
 *      поздравление. Ключ (`birthday:2026-08-03`) уникален в БД, поэтому
 *      гонку решает сама база, а не проверка «уже есть?» перед вставкой;
 *   2. **персональный текст** — «С днём рождения, {{firstName}}» у каждого свой,
 *      и он ложится в `Notification.body` строкой на человека (0036).
 *
 * Всё остальное — как у обычной отправки: строка доставки на получателя,
 * `SKIPPED` без адреса, задачи в очередь после фиксации транзакции.
 */
@Injectable()
export class SystemMailingService {
  private readonly logger = new Logger(SystemMailingService.name);

  constructor(
    private readonly repository: MailingsRepository,
    private readonly dispatcher: MailingDispatcher,
  ) {}

  async dispatch(params: {
    systemKey: string;
    channel: MessageChannel;
    title: string;
    body: string;
    recipients: readonly SystemRecipient[];
  }): Promise<SystemDispatchResult> {
    // Пустая аудитория — не рассылка: за эту дату просто некого поздравлять,
    // и метку идемпотентности не ставим (следующий прогон дёшево переспросит).
    if (params.recipients.length === 0) {
      return { created: false, deliveries: EMPTY_DELIVERY_COUNTS, queued: 0 };
    }

    const seeds = params.recipients.map((recipient) =>
      systemSeedOf(recipient, params.channel, params.body),
    );

    let mailingId: string;
    try {
      mailingId = await this.repository.createSystemMailing({
        systemKey: params.systemKey,
        channel: params.channel,
        title: params.title,
        body: params.body,
        sentAt: new Date(),
        notifications: seeds,
      });
    } catch (error) {
      // За этот ключ рассылку уже завели: повтор задачи и «догон за сегодня»
      // натыкаются на уникальный `systemKey` — и это не ошибка, а именно то,
      // ради чего ключ и заведён.
      if (isSystemKeyConflict(error)) {
        this.logger.debug(`Системная рассылка «${params.systemKey}» уже сделана — пропуск`);

        return { created: false, deliveries: EMPTY_DELIVERY_COUNTS, queued: 0 };
      }

      throw error;
    }

    const queued = seeds
      .filter((seed) => seed.status === NotificationStatus.PENDING)
      .map((seed) => seed.id);

    await this.dispatcher.enqueue(queued);

    const deliveries = countDeliveries(seeds.map((seed) => ({ status: seed.status, count: 1 })));
    this.logger.log(
      `Системная рассылка «${params.systemKey}» (${mailingId}): получателей ` +
        `${String(deliveries.total)}, в очередь ${String(queued.length)}, ` +
        `без адреса ${String(deliveries.skipped)}`,
    );

    return { created: true, deliveries, queued: queued.length };
  }
}

/** Строка доставки системной рассылки: адрес под канал, персональный текст, `SKIPPED` без адреса. */
export const systemSeedOf = (
  recipient: SystemRecipient,
  channel: MessageChannel,
  body: string,
): NotificationSeed => {
  const address = addressFor(channel, recipient);

  return {
    id: randomUUID(),
    channel,
    recipientType: recipient.recipientType,
    recipientName: recipientNameOf(recipient.firstName, recipient.lastName),
    address: address ?? '',
    body: personalBodyOf(body, recipient),
    studentId: recipient.studentId,
    employeeId: recipient.employeeId,
    leadId: recipient.leadId,
    status: address === null ? NotificationStatus.SKIPPED : NotificationStatus.PENDING,
    error: address === null ? NO_ADDRESS_REASON : null,
  };
};

/** Нарушение уникальности именно по `systemKey` — «рассылка за эту дату уже есть». */
const isSystemKeyConflict = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
