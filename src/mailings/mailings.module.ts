import { Module } from '@nestjs/common';

import { MailingDeliveryService } from './mailing-delivery.service';
import { MailingDispatcher, QueueMailingDispatcher } from './mailing-dispatcher';
import { MailingTemplatesController } from './mailing-templates.controller';
import { MailingTemplatesService } from './mailing-templates.service';
import { MailingsController } from './mailings.controller';
import { MailingsRepository } from './mailings.repository';
import { MailingsService } from './mailings.service';

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
  controllers: [MailingTemplatesController, MailingsController],
  providers: [
    MailingsService,
    MailingTemplatesService,
    MailingDeliveryService,
    MailingsRepository,
    { provide: MailingDispatcher, useClass: QueueMailingDispatcher },
  ],
  exports: [MailingDeliveryService],
})
export class MailingsModule {}
