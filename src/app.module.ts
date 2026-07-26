import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { AuthModule } from './auth/auth.module';
import { BranchesModule } from './branches/branches.module';
import { AllExceptionsFilter, TransformResponseInterceptor } from './common';
import { AppConfigModule } from './config/config.module';
import { CoursesModule } from './courses/courses.module';
import { HealthModule } from './health/health.module';
import { LoggerModule } from './logger/logger.module';
import { MailerModule } from './mailer/mailer.module';
import { PhoneModule } from './phone/phone.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { RbacAdminModule } from './rbac/rbac-admin.module';
import { RbacModule } from './rbac/rbac.module';
import { RedisModule } from './redis/redis.module';
import { RoomsModule } from './rooms/rooms.module';
import { StudentsModule } from './students/students.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    MailerModule,
    PhoneModule,
    AuthModule,
    RbacModule,
    RbacAdminModule,
    StudentsModule,
    BranchesModule,
    RoomsModule,
    CoursesModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
  ],
})
export class AppModule {}
