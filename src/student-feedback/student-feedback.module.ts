import { Module } from '@nestjs/common';

import { StudentFeedbackController } from './student-feedback.controller';
import { StudentFeedbackRepository } from './student-feedback.repository';
import { StudentFeedbackService } from './student-feedback.service';

/**
 * Обратная связь по студенту (ТЗ 5.3: Feedback).
 *
 * Отдельный модуль по той же границе, что и остальные вложенные ресурсы проекта:
 * своя таблица, свой репозиторий, свои правила — и наборам тестов карточки
 * студента не приходится подменять хранилище, которым они не пользуются.
 * `PrismaService` — из глобального модуля.
 */
@Module({
  controllers: [StudentFeedbackController],
  providers: [StudentFeedbackService, StudentFeedbackRepository],
})
export class StudentFeedbackModule {}
