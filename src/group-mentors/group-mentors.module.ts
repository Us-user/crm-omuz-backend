import { Module } from '@nestjs/common';

import { GroupMentorsController } from './group-mentors.controller';
import { GroupMentorsRepository } from './group-mentors.repository';
import { GroupMentorsService } from './group-mentors.service';

/**
 * Менторы группы (ТЗ 5.5). Отдельный модуль, а не часть `GroupsModule`, —
 * по той же причине, по которой силлабус не вошёл в `CoursesModule`: у него
 * своя связка, свои правила и свой репозиторий, а тестам групп не нужно знать
 * про менторов (и наоборот). `PrismaService` — из глобального модуля.
 */
@Module({
  controllers: [GroupMentorsController],
  providers: [GroupMentorsService, GroupMentorsRepository],
})
export class GroupMentorsModule {}
