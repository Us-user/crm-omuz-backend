import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { QUEUE_NAMES } from './queue.constants';

/**
 * Базовый обработчик очереди уведомлений. Пока только логирует задачи —
 * реальная отправка через абстракцию «отправитель сообщений» появится в Фазе 11 (ТЗ 3.4).
 */
@Processor(QUEUE_NAMES.Notifications)
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  async process(job: Job<unknown>): Promise<void> {
    this.logger.log(`Задача ${job.name} (#${job.id}) принята в обработку`);
    return Promise.resolve();
  }
}
