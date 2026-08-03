import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { StudentContractsController } from './student-contracts.controller';
import { StudentContractsService } from './student-contracts.service';
import { StudentPromotionService } from './student-promotion.service';
import { StudentsController } from './students.controller';
import { StudentsRepository } from './students.repository';
import { StudentsService } from './students.service';

/**
 * Студенты (ТЗ 5.3): CRUD с формой и статусами, фильтры списка и перевод
 * Студент → Сотрудник (ТЗ 3.1, Фаза 1).
 *
 * Действия «Invite» и «Block» живут в `StudentAccessModule`, заметки —
 * в `StudentFeedbackModule`: у каждого свой репозиторий и свои правила.
 * `Parent/Guardian`, кабинет студента и `GET /students/{id}/performance` —
 * оставшаяся часть Фазы 4.
 *
 * `PhoneService` и `PrismaService` берутся из глобальных модулей.
 */
@Module({
  imports: [DocumentsModule],
  controllers: [StudentsController, StudentContractsController],
  providers: [StudentsService, StudentPromotionService, StudentContractsService, StudentsRepository],
  exports: [StudentPromotionService, StudentContractsService],
})
export class StudentsModule {}

