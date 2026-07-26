import { Module } from '@nestjs/common';

import { StudentPromotionService } from './student-promotion.service';
import { StudentsController } from './students.controller';
import { StudentsRepository } from './students.repository';

/**
 * Студенты (ТЗ 5.3). В Фазе 1 модуль несёт только перевод Студент → Сотрудник;
 * CRUD, статусы, кабинет студента и Performance приходят с Фазой 4.
 *
 * `PhoneService` и `PrismaService` берутся из глобальных модулей.
 */
@Module({
  controllers: [StudentsController],
  providers: [StudentPromotionService, StudentsRepository],
  exports: [StudentPromotionService],
})
export class StudentsModule {}
