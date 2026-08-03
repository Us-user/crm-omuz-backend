import { Module } from '@nestjs/common';

import { LeadersModule } from '../leaders/leaders.module';
import { MailingsModule } from '../mailings/mailings.module';
import { BirthdayService } from './birthday.service';
import { DeliverySweepService } from './delivery-sweep.service';
import { RatingCloseService } from './rating-close.service';
import { ScheduledTasksProcessor } from './scheduled-tasks.processor';
import { ScheduledTasksRegistrar } from './scheduled-tasks.registrar';
import { ScheduledTasksService } from './scheduled-tasks.service';

/**
 * Фоновые задачи по расписанию (ТЗ 3.4): поздравления с ДР, уборка зависших
 * доставок и автозакрытие месяца рейтинга.
 *
 * Как и `MailingsWorkerModule` (0036), модуль поднимает воркер BullMQ
 * (`@Processor`), поэтому подключается только в `AppModule` — наборам, которым
 * нужен лишь HTTP, Redis не требуется. Вся предметная логика вынесена в сервисы
 * без `@Processor`, проверяемые юнит-тестами: обработчик и планировщик только
 * вызывают их.
 *
 * Внешние зависимости — сервисами через границу модуля, а не копией правил:
 *   - `MailingsModule` даёт `SystemMailingService`, репозиторий и диспетчер —
 *     системная отправка это та же машинерия рассылок;
 *   - `LeadersModule` даёт `LeadersService` — автозакрытие переиспускает то же
 *     закрытие месяца, что и ручное (0024).
 */
@Module({
  imports: [MailingsModule, LeadersModule],
  providers: [
    BirthdayService,
    DeliverySweepService,
    RatingCloseService,
    ScheduledTasksService,
    ScheduledTasksProcessor,
    ScheduledTasksRegistrar,
  ],
})
export class SchedulingModule {}
