import { Module } from '@nestjs/common';

import { StudentParentsController } from './student-parents.controller';
import { StudentParentsRepository } from './student-parents.repository';
import { StudentParentsService } from './student-parents.service';

/**
 * Родители и опекуны студента (ТЗ 4: Parent/Guardian).
 *
 * Отдельный модуль по той же границе, что и остальные вложенные ресурсы
 * проекта: свои таблицы, свой репозиторий, свои правила — и наборам тестов
 * карточки студента не приходится подменять хранилище, которым они
 * не пользуются. `PrismaService` и `PhoneService` — из глобальных модулей.
 */
@Module({
  controllers: [StudentParentsController],
  providers: [StudentParentsService, StudentParentsRepository],
})
export class StudentParentsModule {}
