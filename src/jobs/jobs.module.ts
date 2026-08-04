import { Module } from '@nestjs/common';

import { JobsController } from './jobs.controller';
import { JobsRepository } from './jobs.repository';
import { JobsService } from './jobs.service';
import { MeJobsController } from './me-jobs.controller';

/**
 * Вакансии (ТЗ 5.18). Два контроллера на общем сервисе: список центра
 * (`/jobs`, право каталога) и актуальные вакансии в кабинете студента
 * (`/me/jobs`, разрешением служит сам студенческий аккаунт) — приём
 * `AvansModule` (0031) и `MailingsModule` (0037).
 *
 * Отдельный модуль по критерию сессии 0006: свой репозиторий, и наборам
 * тестов кабинета студента не приходится подменять хранилище, которым они
 * не пользуются. Внешних зависимостей нет ни одной — вакансия ни с чем
 * не связана; `PrismaService` приходит из глобального модуля.
 */
@Module({
  controllers: [JobsController, MeJobsController],
  providers: [JobsService, JobsRepository],
})
export class JobsModule {}
