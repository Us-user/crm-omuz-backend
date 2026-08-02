import { Module } from '@nestjs/common';

import { MailingDeliveryProcessor } from './mailing-delivery.processor';
import { MailingsModule } from './mailings.module';

/**
 * Фоновая обработка доставок.
 *
 * Отдельный модуль от `MailingsModule` ровно по одной причине: `@Processor`
 * создаёт воркер BullMQ, а тот подключается к Redis при старте приложения.
 * Держи он рассылки вместе с обработчиком — каждый e2e-набор, которому нужен
 * только HTTP, поднимал бы Redis (критерий 0006: набор не должен поднимать то,
 * чем не пользуется).
 *
 * Подключается в `AppModule`, то есть работает и в проде, и в наборе
 * `health.e2e-spec.ts`, где приложение поднимается целиком против настоящих
 * PostgreSQL и Redis, — там и проверяется, что воркер стартует.
 */
@Module({
  imports: [MailingsModule],
  providers: [MailingDeliveryProcessor],
})
export class MailingsWorkerModule {}
