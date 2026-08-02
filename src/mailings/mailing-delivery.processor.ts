import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import type { MailingDeliverJob } from '../queue/queue.constants';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';
import { DeliveryOutcome, MailingDeliveryService } from './mailing-delivery.service';

/**
 * Обработчик очереди `notifications` — первый работающий в проекте.
 *
 * Сама очередь заведена сессией 0001 с процессором-заглушкой и до сих пор
 * не обработала ни одной задачи; этот класс закрывает последний `[~]` Фазы 0.
 *
 * Логики здесь нет намеренно: она в `MailingDeliveryService`, который
 * проверяется юнит-тестами и e2e без Redis. Процессор отвечает только за две
 * вещи, которые кроме него сделать некому, — понять, последняя ли это попытка,
 * и решить, отдавать ли задачу очереди на повтор.
 */
@Processor(QUEUE_NAMES.Notifications)
export class MailingDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(MailingDeliveryProcessor.name);

  constructor(private readonly delivery: MailingDeliveryService) {
    super();
  }

  async process(job: Job<MailingDeliverJob>): Promise<void> {
    if (job.name !== JOB_NAMES.MailingDeliver) {
      this.logger.warn(`Неизвестная задача ${job.name} (#${String(job.id)}) пропущена`);

      return;
    }

    // `attemptsMade` — сколько попыток **уже** сделано, текущая в него не входит.
    // Поэтому последняя та, после которой счётчик достигнет потолка очереди.
    const attempts = job.opts.attempts ?? 1;
    const lastAttempt = job.attemptsMade + 1 >= attempts;

    const outcome = await this.delivery.deliver(job.data.notificationId, lastAttempt);

    // Повтор просит **сама очередь** — брошенное исключение и есть эта просьба.
    // Остальные исходы задачу завершают: и доставка, и окончательный отказ уже
    // записаны в строку, и второй заход ничего не изменил бы.
    if (outcome === DeliveryOutcome.Retry) {
      throw new Error(`Доставка ${job.data.notificationId} не удалась, требуется повтор`);
    }
  }
}
