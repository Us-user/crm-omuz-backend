import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { AuthModule } from './auth/auth.module';
import { BranchesModule } from './branches/branches.module';
import { AllExceptionsFilter, TransformResponseInterceptor } from './common';
import { AppConfigModule } from './config/config.module';
import { CoursesModule } from './courses/courses.module';
import { GroupJournalModule } from './group-journal/group-journal.module';
import { GroupMentorsModule } from './group-mentors/group-mentors.module';
import { GroupScheduleModule } from './group-schedule/group-schedule.module';
import { GroupStudentsModule } from './group-students/group-students.module';
import { GroupsModule } from './groups/groups.module';
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
import { StudentAccessModule } from './student-access/student-access.module';
import { StudentCabinetModule } from './student-cabinet/student-cabinet.module';
import { StudentCoinsModule } from './student-coins/student-coins.module';
import { StudentFeedbackModule } from './student-feedback/student-feedback.module';
import { StudentParentsModule } from './student-parents/student-parents.module';
import { StudentsModule } from './students/students.module';
import { SyllabusModule } from './syllabus/syllabus.module';

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
    StudentAccessModule,
    StudentCabinetModule,
    StudentCoinsModule,
    StudentFeedbackModule,
    StudentParentsModule,
    BranchesModule,
    RoomsModule,
    CoursesModule,
    GroupsModule,
    GroupJournalModule,
    GroupMentorsModule,
    GroupScheduleModule,
    GroupStudentsModule,
    SyllabusModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
  ],
})
export class AppModule {}
