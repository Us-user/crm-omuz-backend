import { Module } from '@nestjs/common';

import { EmployeeMentorLevelsController } from './employee-mentor-levels.controller';
import { EmployeeMentorLevelsService } from './employee-mentor-levels.service';
import { MentorLevelsController } from './mentor-levels.controller';
import { MentorLevelsRepository } from './mentor-levels.repository';
import { MentorLevelsService } from './mentor-levels.service';

/**
 * Уровни ментора (ТЗ 5.14): справочник ступеней со ставкой и помесячная
 * история сотрудников.
 *
 * Два контроллера в одном модуле, а не два модуля: у них общие правила
 * и общая пара таблиц — простановка уровня смотрит в справочник, а удаление
 * ступени упирается в историю. Разведённые модули заставили бы e2e держать
 * в согласии два хранилища ради одного набора правил.
 *
 * Отдельно от `EmployeesModule`, хотя история вложена в `/employees/{id}`:
 * критерий действует с сессии 0006 — иначе каждому e2e-набору карточки
 * сотрудника пришлось бы подменять репозиторий, которым он не пользуется.
 *
 * `PrismaService` — из глобального модуля.
 */
@Module({
  controllers: [MentorLevelsController, EmployeeMentorLevelsController],
  providers: [MentorLevelsService, EmployeeMentorLevelsService, MentorLevelsRepository],
})
export class MentorLevelsModule {}
