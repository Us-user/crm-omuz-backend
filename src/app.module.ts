import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { AccountingModule } from './accounting/accounting.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AvansModule } from './avans/avans.module';
import { BranchesModule } from './branches/branches.module';
import { AllExceptionsFilter, TransformResponseInterceptor } from './common';
import { AppConfigModule } from './config/config.module';
import { CouponsModule } from './coupons/coupons.module';
import { CoursesModule } from './courses/courses.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { EmployeesModule } from './employees/employees.module';
import { GroupJournalModule } from './group-journal/group-journal.module';
import { GroupMentorsModule } from './group-mentors/group-mentors.module';
import { GroupScheduleModule } from './group-schedule/group-schedule.module';
import { GroupStudentsModule } from './group-students/group-students.module';
import { GraduatesModule } from './graduates/graduates.module';
import { GroupsModule } from './groups/groups.module';
import { HealthModule } from './health/health.module';
import { JobsModule } from './jobs/jobs.module';
import { LeadersModule } from './leaders/leaders.module';
import { LeadsModule } from './leads/leads.module';
import { LeftCoursesModule } from './left-courses/left-courses.module';
import { LoggerModule } from './logger/logger.module';
import { MailerModule } from './mailer/mailer.module';
import { MailingsWorkerModule } from './mailings/mailings-worker.module';
import { MailingsModule } from './mailings/mailings.module';
import { MentorCabinetModule } from './mentor-cabinet/mentor-cabinet.module';
import { MessagingModule } from './messaging/messaging.module';
import { MentorLevelsModule } from './mentor-levels/mentor-levels.module';
import { PerformanceModule } from './performance/performance.module';
import { PhoneModule } from './phone/phone.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { RbacAdminModule } from './rbac/rbac-admin.module';
import { RbacModule } from './rbac/rbac.module';
import { RedisModule } from './redis/redis.module';
import { RoomsModule } from './rooms/rooms.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { StudentAccessModule } from './student-access/student-access.module';
import { StudentCabinetModule } from './student-cabinet/student-cabinet.module';
import { StudentCoinsModule } from './student-coins/student-coins.module';
import { StudentFeedbackModule } from './student-feedback/student-feedback.module';
import { StudentParentsModule } from './student-parents/student-parents.module';
import { StudentContractsModule } from './students/student-contracts.module';
import { StudentsModule } from './students/students.module';
import { SyllabusModule } from './syllabus/syllabus.module';
import { TimetableModule } from './timetable/timetable.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    MailerModule,
    MessagingModule,
    PhoneModule,
    // Ограничение частоты запросов (ТЗ 3.8). Порядка не требует: guard
    // приезжает декоратором эндпоинта, а не глобально, — в отличие
    // от журнала ниже.
    RateLimitModule,
    // Журнал действий (ТЗ 3.6). Стоит **раньше `AuthModule`** осознанно:
    // глобальные guard'ы выполняются в порядке регистрации, и запись «кто
    // ломился в закрытый эндпоинт» возможна только если журнал успел
    // подписаться на ответ до отказа `JwtAuthGuard`. На порядок есть e2e-тест.
    AuditModule,
    AuthModule,
    RbacModule,
    RbacAdminModule,
    StudentsModule,
    // Договоры вынесены из `StudentsModule` (Фаза 12 держала их там, и модуль
    // студентов начал требовать живой Prisma от каждого e2e-набора).
    StudentContractsModule,
    StudentAccessModule,
    StudentCabinetModule,
    StudentCoinsModule,
    StudentFeedbackModule,
    StudentParentsModule,
    PerformanceModule,
    LeadersModule,
    LeadsModule,
    CouponsModule,
    LeftCoursesModule,
    GraduatesModule,
    EmployeesModule,
    MentorCabinetModule,
    MentorLevelsModule,
    AvansModule,
    AccountingModule,
    BranchesModule,
    RoomsModule,
    CoursesModule,
    GroupsModule,
    GroupJournalModule,
    GroupMentorsModule,
    GroupScheduleModule,
    GroupStudentsModule,
    SyllabusModule,
    TimetableModule,
    DashboardModule,
    // Вакансии (ТЗ 5.18): список центра и его же актуальная часть в кабинете
    // студента — оба контроллера приезжают одним модулем.
    JobsModule,
    MailingsModule,
    // Обработчик очереди подключается отдельным модулем: он создаёт воркер
    // BullMQ, и e2e-наборам рассылок Redis для этого не нужен.
    MailingsWorkerModule,
    // Фоновые задачи по расписанию (поздравления с ДР, уборка доставок,
    // автозакрытие рейтинга) — тоже воркер BullMQ, потому и отдельным модулем.
    SchedulingModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
  ],
})
export class AppModule {}
