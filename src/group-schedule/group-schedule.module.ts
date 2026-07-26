import { Module } from '@nestjs/common';

import { GroupScheduleController } from './group-schedule.controller';
import { GroupScheduleRepository } from './group-schedule.repository';
import { GroupScheduleService } from './group-schedule.service';

/**
 * Расписание группы (ТЗ 5.5, 5.10). Отдельный модуль, а не часть `GroupsModule`, —
 * по той же причине, что менторы и силлабус: своя таблица, свои правила и свой
 * репозиторий, а тестам групп не нужно знать про расписание.
 * `PrismaService` — из глобального модуля.
 */
@Module({
  controllers: [GroupScheduleController],
  providers: [GroupScheduleService, GroupScheduleRepository],
})
export class GroupScheduleModule {}
