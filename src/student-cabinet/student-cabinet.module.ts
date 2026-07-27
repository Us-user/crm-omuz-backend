import { Module } from '@nestjs/common';

import { PerformanceModule } from '../performance/performance.module';
import { StudentCabinetController } from './student-cabinet.controller';
import { StudentCabinetRepository } from './student-cabinet.repository';
import { StudentCabinetService } from './student-cabinet.service';

/**
 * Кабинет студента (ТЗ 5.3: «только просмотр»).
 *
 * Отдельный модуль по той же границе, что и остальные контуры студента:
 * свой репозиторий и свои правила — и наборам тестов админ-стороны не приходится
 * подменять хранилище, которым они не пользуются. `PrismaService` — из глобального
 * модуля, права каталога здесь не нужны: у студента их нет по определению (ТЗ 3.2).
 *
 * `PerformanceModule` — единственная внешняя зависимость: «мои баллы» и «мой
 * рейтинг» (ТЗ 5.3) это тот же расчёт, что и на карточке студента, только
 * адресованный от токена. Здесь через границу модуля переходит **сервис**,
 * а не чистая функция (как в студентах и группах): считать балл заново значило
 * бы завести второе место, где решается, какие недели входят в средний, — и оно
 * разошлось бы с первым молча.
 */
@Module({
  imports: [PerformanceModule],
  controllers: [StudentCabinetController],
  providers: [StudentCabinetService, StudentCabinetRepository],
})
export class StudentCabinetModule {}
