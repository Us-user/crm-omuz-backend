import { Module } from '@nestjs/common';

import { PerformanceController } from './performance.controller';
import { PerformanceRepository } from './performance.repository';
import { PerformanceService } from './performance.service';

/**
 * Успеваемость (ТЗ 5.3, 5.8). Отдельный модуль, а не рост `StudentsModule`:
 * критерий действует с сессии 0006 — иначе каждому e2e-набору карточки студента
 * пришлось бы подменять ещё один репозиторий, которым он не пользуется.
 *
 * Правило подсчёта (`performance.ts`) при этом общее: его чистые функции
 * импортируют и студенты (корона и категория в списке), и группы (счётчики
 * категорий) — через границу модуля переходит функция, а не сервис.
 */
@Module({
  controllers: [PerformanceController],
  providers: [PerformanceService, PerformanceRepository],
  exports: [PerformanceService],
})
export class PerformanceModule {}
