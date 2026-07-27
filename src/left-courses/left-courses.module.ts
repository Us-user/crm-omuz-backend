import { Module } from '@nestjs/common';

import { LeftCoursesController } from './left-courses.controller';
import { LeftCoursesRepository } from './left-courses.repository';
import { LeftCoursesService } from './left-courses.service';

/**
 * Покинувшие курсы (ТЗ 5.12). Отдельный модуль, а не рост `GroupStudentsModule`:
 * критерий действует с сессии 0006 — иначе e2e-набору состава группы пришлось бы
 * подменять ещё один репозиторий, которым он не пользуется.
 *
 * Границу при этом держит не только удобство тестов: состав группы **меняет**
 * данные (зачисление, перевод, смена статуса), а витрина только читает их
 * по всему центру. Общим остаётся сам факт ухода — строка `GroupStudent`
 * со статусом `LEFT`, которую пишет состав и читает эта витрина.
 *
 * `PrismaService` — из глобального модуля.
 */
@Module({
  controllers: [LeftCoursesController],
  providers: [LeftCoursesService, LeftCoursesRepository],
  exports: [LeftCoursesService],
})
export class LeftCoursesModule {}
