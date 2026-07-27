import { Module } from '@nestjs/common';

import { GraduatesModule } from '../graduates/graduates.module';
import { GroupsController } from './groups.controller';
import { GroupsRepository } from './groups.repository';
import { GroupsService } from './groups.service';

/**
 * Учебные группы (ТЗ 5.5). `PrismaService` — из глобального модуля.
 *
 * `GraduatesModule` импортируется ради автовыпуска (ТЗ 5.11): перевод группы
 * курса с «Is last course» в статус `FINISHED` — то самое событие, по которому
 * заводятся выпускники. Зависимость односторонняя: выпускникам `GroupsModule`
 * не нужен.
 */
@Module({
  imports: [GraduatesModule],
  controllers: [GroupsController],
  providers: [GroupsService, GroupsRepository],
})
export class GroupsModule {}
