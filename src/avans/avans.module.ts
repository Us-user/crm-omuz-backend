import { Module } from '@nestjs/common';

import { AvansController } from './avans.controller';
import { AvansRepository } from './avans.repository';
import { AvansService } from './avans.service';

/**
 * Заявки на аванс (ТЗ 5.14): подача и просмотр. Рассмотрение — бухгалтерия
 * (`/accounting/avans/{id}/approve|deny`, ТЗ 5.16, Фаза 9).
 *
 * Отдельно от `EmployeesModule`, хотя маршруты вложены в `/employees/{id}`:
 * критерий действует с сессии 0006 — иначе каждому e2e-набору карточки
 * сотрудника пришлось бы подменять репозиторий, которым он не пользуется.
 *
 * `PrismaService` — из глобального модуля.
 */
@Module({
  controllers: [AvansController],
  providers: [AvansService, AvansRepository],
})
export class AvansModule {}
