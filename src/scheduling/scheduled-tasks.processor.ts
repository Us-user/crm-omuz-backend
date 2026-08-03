import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';
import { ScheduledTasksService } from './scheduled-tasks.service';

/**
 * Обработчик очереди `scheduled` (ТЗ 3.4).
 *
 * Логики здесь нет намеренно — она в сервисах, проверяемых без Redis (тот же
 * приём, что у `MailingDeliveryProcessor`, 0036). Процессор лишь берёт момент
 * времени «сейчас» и по имени задачи выбирает суточный или месячный тик.
 */
@Processor(QUEUE_NAMES.Scheduled)
export class ScheduledTasksProcessor extends WorkerHost {
  private readonly logger = new Logger(ScheduledTasksProcessor.name);

  constructor(private readonly tasks: ScheduledTasksService) {
    super();
  }

  async process(job: Job): Promise<void> {
    const now = new Date();

    if (job.name === JOB_NAMES.DailyTasks) {
      await this.tasks.runDaily(now);

      return;
    }

    if (job.name === JOB_NAMES.MonthlyTasks) {
      await this.tasks.runMonthly(now);

      return;
    }

    this.logger.warn(`Неизвестная задача расписания ${job.name} (#${String(job.id)}) пропущена`);
  }
}
