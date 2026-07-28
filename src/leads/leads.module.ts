import { Module } from '@nestjs/common';

import { LeadsController } from './leads.controller';
import { LeadsRepository } from './leads.repository';
import { LeadsService } from './leads.service';

/**
 * Лиды и клиенты (ТЗ 5.7). Отдельный модуль от купонов: критерий сессии 0006 —
 * иначе каждому e2e-набору купонов пришлось бы подменять репозиторий, которым
 * он не пользуется.
 *
 * Существование курса, купона и филиала лиды проверяют **своим** репозиторием,
 * а не зависимостью от трёх модулей — так же, как выпускники читают группу
 * (0026), а расписание — аудиторию (0011).
 *
 * `PhoneService` — из глобального `PhoneModule`, `PrismaService` — из глобального
 * `PrismaModule`.
 */
@Module({
  controllers: [LeadsController],
  providers: [LeadsService, LeadsRepository],
})
export class LeadsModule {}
