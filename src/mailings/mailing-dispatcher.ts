import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';

/**
 * Постановка доставок в очередь.
 *
 * Отдельная абстракция, а не `@InjectQueue` прямо в сервисе рассылок, —
 * по двум причинам сразу:
 *
 * 1. Отправка на пятьсот человек не должна держать HTTP-запрос: контроллер
 *    отвечает `202 Accepted`, а доставка идёт фоном (решение пользователя).
 * 2. Проверяемость. `Queue` из BullMQ подключается к Redis при создании,
 *    и e2e-набор, которому Redis не нужен, подменяет **этот** контракт одной
 *    строкой — не трогая ни очередь, ни `BullModule` (критерий 0006:
 *    набор не должен поднимать то, чем не пользуется).
 */
export abstract class MailingDispatcher {
  /**
   * Ставит по задаче на каждую доставку.
   *
   * Вызывается **после** фиксации транзакции: задача, поставленная до неё,
   * может быть взята обработчиком раньше, чем строка станет видна другому
   * соединению, и упасть на «доставка не найдена».
   */
  abstract enqueue(notificationIds: readonly string[]): Promise<void>;
}

/** Рабочая реализация поверх очереди `notifications`, заведённой в 0001. */
@Injectable()
export class QueueMailingDispatcher extends MailingDispatcher {
  private readonly logger = new Logger(QueueMailingDispatcher.name);

  constructor(@InjectQueue(QUEUE_NAMES.Notifications) private readonly queue: Queue) {
    super();
  }

  async enqueue(notificationIds: readonly string[]): Promise<void> {
    if (notificationIds.length === 0) return;

    // `addBulk`, а не `add` в цикле: тысяча отдельных обращений к Redis
    // на одну рассылку — это тысяча round-trip'ов там, где хватает одного.
    await this.queue.addBulk(
      notificationIds.map((notificationId) => ({
        name: JOB_NAMES.MailingDeliver,
        data: { notificationId },
      })),
    );

    this.logger.log(`В очередь поставлено доставок: ${String(notificationIds.length)}`);
  }
}
