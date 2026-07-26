import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { AllExceptionsFilter, TransformResponseInterceptor } from './common';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { LoggerModule } from './logger/logger.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [AppConfigModule, LoggerModule, PrismaModule, RedisModule, QueueModule, HealthModule],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
  ],
})
export class AppModule {}
