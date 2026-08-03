import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';

import { AppConfigService } from '../config';
import { AppConfigModule } from '../config/config.module';
import { QUEUE_NAMES } from './queue.constants';

/**
 * Очередь фоновых задач (ТЗ 2).
 *
 * Обработчика здесь **нет**: он живёт рядом со своей предметной областью —
 * `MailingDeliveryProcessor` в `MailingsWorkerModule`. Заглушка, стоявшая тут
 * с сессии 0001, удалена вместе с появлением настоящего обработчика: два
 * `@Processor` на одну очередь создали бы двух воркеров, и задачи делились бы
 * между ними случайно — половина рассылки молча уходила бы в лог заглушки.
 *
 * Модуль остаётся глобальным и экспортирует `BullModule`: очередь
 * `notifications` регистрируется один раз, а ставить в неё задачи может любой
 * модуль через `@InjectQueue`.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => {
        const { host, port, password, db } = config.redis;
        return {
          connection: {
            host,
            port,
            password,
            db,
            retryStrategy: (times: number) => Math.min(times * 500, 10_000),
          },
          defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: { age: 3_600, count: 1_000 },
            removeOnFail: { age: 24 * 3_600 },
          },
        };
      },
    }),
    BullModule.registerQueue({ name: QUEUE_NAMES.Notifications }),
    // Очередь повторяющихся задач по расписанию (ТЗ 3.4). Регистрируется здесь,
    // чтобы и планировщик, и обработчик получали её через `@InjectQueue`.
    BullModule.registerQueue({ name: QUEUE_NAMES.Scheduled }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
