import { Module } from '@nestjs/common';

import { TimetableController } from './timetable.controller';
import { TimetableRepository } from './timetable.repository';
import { TimetableService } from './timetable.service';

/**
 * Общее расписание центра (ТЗ 5.10). Отдельный модуль, а не рост
 * `GroupScheduleModule`: критерий действует с сессии 0006 — иначе e2e-набору
 * расписания группы пришлось бы подменять ещё один репозиторий, которым
 * он не пользуется.
 *
 * Границу держит не только удобство тестов: расписание группы **меняет** слоты
 * и несёт все правила записи (аудитория из филиала группы, ментор из состава
 * менторов, пересечения), а календарь только читает их по всему центру
 * и добавляет ровно одно новое умение — разворот в даты. Та же граница, что
 * между составом группы и витриной покинувших курсы (0025).
 *
 * Зависимостей от других доменных модулей нет: журнал читается своим
 * репозиторием — приём 0011 (расписание читает аудиторию), 0026 (выпускники
 * читают группу) и 0027 (лиды читают курс).
 *
 * `PrismaService` — из глобального модуля.
 */
@Module({
  controllers: [TimetableController],
  providers: [TimetableService, TimetableRepository],
  exports: [TimetableService],
})
export class TimetableModule {}
