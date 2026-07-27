import { Module } from '@nestjs/common';

import { StudentCoinsController } from './student-coins.controller';
import { StudentCoinsRepository } from './student-coins.repository';
import { StudentCoinsService } from './student-coins.service';

/**
 * Коины студента (ТЗ 5.9). Отдельный модуль, а не часть `StudentsModule`, —
 * по критерию, действующему с сессии 0006: иначе каждому e2e-набору карточки
 * студента пришлось бы подменять ещё один репозиторий, которым он не пользуется.
 * `PrismaService` — из глобального модуля.
 */
@Module({
  controllers: [StudentCoinsController],
  providers: [StudentCoinsService, StudentCoinsRepository],
})
export class StudentCoinsModule {}
