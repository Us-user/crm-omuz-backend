import { Module } from '@nestjs/common';

import { DocumentsModule } from '../documents/documents.module';
import { GraduatesController } from './graduates.controller';
import { GraduatesRepository } from './graduates.repository';
import { GraduatesService } from './graduates.service';

/**
 * Выпускники (ТЗ 5.11). Отдельный модуль, а не рост `GroupsModule`: критерий
 * действует с сессии 0006.
 *
 * `GraduatesService` **экспортируется** — его вызывает `GroupsService`, когда
 * группа оказывается в статусе `FINISHED`. Через границу модуля здесь переходит
 * сервис, а не чистая функция, и это осознанно: автовыпуск — не «правило,
 * применяемое в двух местах», а поведение, которое целиком живёт здесь;
 * группы всего лишь сообщают ему о событии. Третий такой случай после кабинета
 * студента с `PerformanceService` (0020) и кабинета ментора с `AvansService`
 * (0023).
 *
 * Обратной зависимости нет: выпускникам не нужен `GroupsModule` — всё, что им
 * требуется знать о группе (флаг «Is last course», срок, состав), они читают
 * своим репозиторием.
 *
 * `PrismaService` — из глобального модуля.
 */
@Module({
  imports: [DocumentsModule],
  controllers: [GraduatesController],
  providers: [GraduatesService, GraduatesRepository],
  exports: [GraduatesService],
})
export class GraduatesModule {}
