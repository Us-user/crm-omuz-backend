import { Module } from '@nestjs/common';

import { AvansReviewController } from './avans-review.controller';
import { AvansReviewService } from './avans-review.service';
import { AvansController } from './avans.controller';
import { AvansRepository } from './avans.repository';
import { AvansService } from './avans.service';

/**
 * Заявки на аванс: подача и просмотр по сотруднику (ТЗ 5.14,
 * `/employees/{id}/avans`) и рассмотрение бухгалтерией (ТЗ 5.16,
 * `/accounting/avans`).
 *
 * Два контроллера на одном репозитории — тот же ход, что у справочника
 * и истории уровней ментора (0021): подача и рассмотрение связаны правилом
 * «одна нерассмотренная заявка на сотрудника», и разведённые модули заставили
 * бы e2e держать в согласии два хранилища ради одного набора правил. Заодно
 * `AccountingModule` остаётся без зависимости от соседнего домена.
 *
 * Отдельно от `EmployeesModule`, хотя маршруты вложены в `/employees/{id}`:
 * критерий действует с сессии 0006 — иначе каждому e2e-набору карточки
 * сотрудника пришлось бы подменять репозиторий, которым он не пользуется.
 *
 * `PrismaService` — из глобального модуля.
 */
@Module({
  controllers: [AvansController, AvansReviewController],
  providers: [AvansService, AvansReviewService, AvansRepository],
  // Сервис экспортируется ради кабинета ментора (ТЗ 5.4): подача заявки о себе —
  // тот же сценарий, только адресованный от токена, и второй его экземпляр
  // разошёлся бы с первым в правилах, которые касаются денег (сессия 0022).
  exports: [AvansService],
})
export class AvansModule {}
