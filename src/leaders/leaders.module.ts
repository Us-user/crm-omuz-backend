import { Module } from '@nestjs/common';

import { LeadersController } from './leaders.controller';
import { LeadersRepository } from './leaders.repository';
import { LeadersService } from './leaders.service';

/**
 * Лидеры и рейтинг центра (ТЗ 5.13). Отдельный модуль, а не рост
 * `PerformanceModule`: критерий действует с сессии 0006 — иначе e2e-набору
 * успеваемости пришлось бы подменять ещё один репозиторий, которым он
 * не пользуется.
 *
 * Общим при этом остаётся **правило**: пороги категорий, `roundScore`
 * и фильтры «только финализированные недели» / «только учащиеся сейчас»
 * импортируются из `performance.ts` — через границу модуля переходят
 * функции и константы, а не сервис.
 *
 * `PrismaService` — из глобального модуля.
 */
@Module({
  controllers: [LeadersController],
  providers: [LeadersService, LeadersRepository],
  exports: [LeadersService],
})
export class LeadersModule {}
