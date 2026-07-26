import { Module } from '@nestjs/common';

import { GroupsController } from './groups.controller';
import { GroupsRepository } from './groups.repository';
import { GroupsService } from './groups.service';

/** Учебные группы (ТЗ 5.5). `PrismaService` — из глобального модуля. */
@Module({
  controllers: [GroupsController],
  providers: [GroupsService, GroupsRepository],
})
export class GroupsModule {}
