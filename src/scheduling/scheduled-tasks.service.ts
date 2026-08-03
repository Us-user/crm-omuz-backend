import { Injectable } from '@nestjs/common';

import type { BirthdayRunResult } from './birthday.service';
import { BirthdayService } from './birthday.service';
import { DeliverySweepService } from './delivery-sweep.service';
import type { RatingCloseResult } from './rating-close.service';
import { RatingCloseService } from './rating-close.service';

/** Итог суточного тика — уходит в отчёт задачи. */
export interface DailyRunResult {
  birthday: BirthdayRunResult;
  sweep: { requeued: number };
}

/**
 * Оркестратор фоновых задач по расписанию (ТЗ 3.4).
 *
 * Собирает суточный и месячный тики из отдельных сервисов и ничего сам не решает:
 * так и обработчик очереди, и «догон при старте» вызывают одно и то же, а каждый
 * шаг проверяется по отдельности. Момент времени приходит параметром — расписание
 * задаёт его настоящим, тест — любым.
 */
@Injectable()
export class ScheduledTasksService {
  constructor(
    private readonly birthday: BirthdayService,
    private readonly sweep: DeliverySweepService,
    private readonly ratingClose: RatingCloseService,
  ) {}

  /** Суточный тик: поздравления с ДР и уборка зависших доставок. */
  async runDaily(now: Date): Promise<DailyRunResult> {
    const birthday = await this.birthday.congratulate(now);
    const sweep = await this.sweep.sweep(now);

    return { birthday, sweep };
  }

  /** Месячный тик: автозакрытие прошлого месяца рейтинга. */
  runMonthly(now: Date): Promise<RatingCloseResult> {
    return this.ratingClose.closeLastMonth(now);
  }
}
