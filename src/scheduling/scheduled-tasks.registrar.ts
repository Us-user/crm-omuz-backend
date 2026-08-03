import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { AppConfigService } from '../config';
import { JOB_NAMES, QUEUE_NAMES, SCHEDULES } from '../queue/queue.constants';
import { ScheduledTasksService } from './scheduled-tasks.service';

/**
 * Регистрация повторяющихся задач и «догон за сегодня» при старте (ТЗ 3.4).
 *
 * Два действия при подъёме приложения:
 *   1. **завести расписания** — суточное (поздравления + уборка) и месячное
 *      (закрытие рейтинга) через Job Scheduler BullMQ. `upsertJobScheduler`
 *      идемпотентен: повторный старт не плодит дубли расписаний;
 *   2. **догнать сегодня** — сразу выполнить суточный тик один раз. Это ответ
 *      на «что делать при простое» (решение пользователя): если приложение
 *      лежало в момент срабатывания, именинники сегодняшнего дня всё равно
 *      получат поздравление, а зависшие доставки — уборку. Прошлые дни
 *      не досылаются: запоздалое «с ДР» хуже, чем никакого. Повтора не будет —
 *      ключ `birthday:YYYY-MM-DD` уникален.
 *
 * В тестовом окружении и при выключенном планировщике не делает ничего:
 * расписания живут в Redis, а наборам он не нужен (критерий 0006).
 */
@Injectable()
export class ScheduledTasksRegistrar implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScheduledTasksRegistrar.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.Scheduled) private readonly queue: Queue,
    private readonly config: AppConfigService,
    private readonly tasks: ScheduledTasksService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.isTest || !this.config.scheduledTasksEnabled) return;

    try {
      await this.queue.upsertJobScheduler(
        SCHEDULES.Daily.id,
        { pattern: SCHEDULES.Daily.pattern },
        { name: JOB_NAMES.DailyTasks },
      );
      await this.queue.upsertJobScheduler(
        SCHEDULES.Monthly.id,
        { pattern: SCHEDULES.Monthly.pattern },
        { name: JOB_NAMES.MonthlyTasks },
      );
      this.logger.log('Расписания фоновых задач зарегистрированы (суточное и месячное)');
    } catch (error) {
      // Сбой регистрации расписания не должен ронять приложение: HTTP работает
      // и без фоновых задач, а «догон за сегодня» ниже отработает всё равно.
      this.logger.error(`Не удалось зарегистрировать расписания: ${messageOf(error)}`);
    }

    try {
      const result = await this.tasks.runDaily(new Date());
      this.logger.log(
        `Догон за сегодня: именинников ${String(result.birthday.birthdays)}, ` +
          `доставок поднято ${String(result.sweep.requeued)}`,
      );
    } catch (error) {
      this.logger.error(`Догон суточной задачи при старте не удался: ${messageOf(error)}`);
    }
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
