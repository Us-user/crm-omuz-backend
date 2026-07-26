import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';

import { AppConfigService } from '../config';
import { AppConfigModule } from '../config/config.module';
import { NotificationsProcessor } from './notifications.processor';
import { QUEUE_NAMES } from './queue.constants';

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
  ],
  providers: [NotificationsProcessor],
  exports: [BullModule],
})
export class QueueModule {}
