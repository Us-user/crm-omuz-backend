import { Module } from '@nestjs/common';

import { GroupStudentsController } from './group-students.controller';
import { GroupStudentsRepository } from './group-students.repository';
import { GroupStudentsService } from './group-students.service';

/**
 * Состав группы (ТЗ 5.5). Отдельный модуль, а не часть `GroupsModule`, —
 * по той же причине, что менторы и расписание: своя связка, свои правила
 * и свой репозиторий, а тестам групп не нужно знать про состав (и наоборот).
 * `PrismaService` — из глобального модуля.
 */
@Module({
  controllers: [GroupStudentsController],
  providers: [GroupStudentsService, GroupStudentsRepository],
})
export class GroupStudentsModule {}
