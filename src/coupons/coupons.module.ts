import { Module } from '@nestjs/common';

import { CouponsController } from './coupons.controller';
import { CouponsRepository } from './coupons.repository';
import { CouponsService } from './coupons.service';

/**
 * Купоны (ТЗ 5.7). Отдельный модуль, а не часть будущего `LeadsModule`:
 * критерий действует с сессии 0006 — иначе каждому e2e-набору лидов пришлось бы
 * подменять репозиторий, которым он не пользуется.
 *
 * Обратной зависимости у лидов на этот модуль тоже нет: существование купона
 * они проверяют своим репозиторием, как выпускники проверяют группу (0026).
 *
 * `PrismaService` — из глобального модуля.
 */
@Module({
  controllers: [CouponsController],
  providers: [CouponsService, CouponsRepository],
})
export class CouponsModule {}
