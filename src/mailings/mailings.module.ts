import { Module } from '@nestjs/common';

import { MailingDeliveryService } from './mailing-delivery.service';
import { MailingDispatcher, QueueMailingDispatcher } from './mailing-dispatcher';
import { MailingTemplatesController } from './mailing-templates.controller';
import { MailingTemplatesService } from './mailing-templates.service';
import { MailingsController } from './mailings.controller';
import { MailingsRepository } from './mailings.repository';
import { MailingsService } from './mailings.service';
import { MentorMailingsController } from './mentor-mailings.controller';
import { SystemMailingService } from './system-mailing.service';

/**
 * Рассылки и шаблоны (ТЗ 5.19).
 *
 * Контроллер шаблонов объявлен **первым**: `/mailings/templates` иначе попал бы
 * в `/mailings/{id}` и вернулся бы 400 «не UUID». Порядок контроллеров в модуле —
 * часть маршрутизации Nest, и полагаться здесь на случайность нельзя.
 *
 * Обработчика очереди тут нет: он живёт в `MailingsWorkerModule`. Причина
 * прикладная, а не вкусовая — `@Processor` создаёт воркер BullMQ, который
 * подключается к Redis при старте, и e2e-набору рассылок Redis не нужен
 * (критерий 0006). Правила доставки при этом проверяются полностью: они
 * в `MailingDeliveryService`, который здесь и остаётся.
 *
 * `PrismaService` и `MessageSender` — из глобальных модулей.
 */
@Module({
  controllers: [MailingTemplatesController, MailingsController, MentorMailingsController],
  providers: [
    MailingsService,
    MailingTemplatesService,
    MailingDeliveryService,
    SystemMailingService,
    MailingsRepository,
    { provide: MailingDispatcher, useClass: QueueMailingDispatcher },
  ],
  // `SystemMailingService`, репозиторий и диспетчер экспортируются для
  // `SchedulingModule` (поздравления с ДР, уборка доставок): системная отправка
  // и постановка в очередь — та же машинерия рассылок, а не её копия.
  exports: [MailingDeliveryService, SystemMailingService, MailingsRepository, MailingDispatcher],
})
export class MailingsModule {}
