import { Module } from '@nestjs/common';

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
 */
@Module({
  controllers: [StudentCabinetController],
  providers: [StudentCabinetService, StudentCabinetRepository],
})
export class StudentCabinetModule {}
