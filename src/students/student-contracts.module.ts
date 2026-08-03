import { Module } from '@nestjs/common';

import { DocumentsModule } from '../documents/documents.module';
import { StudentContractsController } from './student-contracts.controller';
import { StudentContractsService } from './student-contracts.service';

/**
 * Договоры студента (ТЗ 5.3, 3.7) — отдельный модуль, а не часть
 * `StudentsModule`, по критерию сессии 0006: `StudentContractsService`
 * обращается к `PrismaService` напрямую, и, оставаясь в модуле студентов,
 * он требовал бы живого Prisma от каждого e2e-набора, который импортирует
 * `StudentsModule` ради карточки студента и подменяет только репозиторий
 * (на этом и падали три набора после Фазы 12).
 *
 * Тот же ход, что с `StudentAccessModule`, `StudentFeedbackModule`,
 * `StudentCoinsModule` и `StudentParentsModule`: у каждого действия
 * над студентом — свой модуль.
 *
 * `PrismaService` — из глобального модуля.
 */
@Module({
  imports: [DocumentsModule],
  controllers: [StudentContractsController],
  providers: [StudentContractsService],
})
export class StudentContractsModule {}
