import { Module } from '@nestjs/common';

import { StudentPromotionService } from './student-promotion.service';
import { StudentsController } from './students.controller';
import { StudentsRepository } from './students.repository';
import { StudentsService } from './students.service';

/**
 * Студенты (ТЗ 5.3): CRUD с формой и статусами, фильтры списка и перевод
 * Студент → Сотрудник (ТЗ 3.1, Фаза 1).
 *
 * Действия «Invite» и «Block» живут в `StudentAccessModule`, заметки —
 * в `StudentFeedbackModule`, договоры (ТЗ 3.7, Фаза 12) —
 * в `StudentContractsModule`: у каждого свой репозиторий и свои правила.
 *
 * `PhoneService` и `PrismaService` берутся из глобальных модулей.
 */
@Module({
  controllers: [StudentsController],
  providers: [StudentsService, StudentPromotionService, StudentsRepository],
  exports: [StudentPromotionService],
})
export class StudentsModule {}
