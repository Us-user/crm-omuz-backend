import { Module } from '@nestjs/common';

import { DashboardController } from './dashboard.controller';
import { DashboardRepository } from './dashboard.repository';
import { DashboardService } from './dashboard.service';

/**
 * Дашборд (ТЗ 5.2) — сводная витрина центра.
 *
 * Отдельный модуль со **своим** репозиторием, а не набор методов, разложенный
 * по шести существующим модулям. Критерий действует с сессии 0006, но здесь
 * у него есть и содержательная сторона: дашборд читает **весь центр сразу**,
 * а каждый из шести доменов отвечает за свой кусок и умеет его менять.
 * Зависимость от `AccountingRepository` или `LeftCoursesRepository` заставила бы
 * каждый e2e-набор дашборда подменять репозитории, которыми он не пользуется.
 *
 * Через границу модуля переходят **правила** (чистые функции `summarize`,
 * `employmentCountsOf`, `isArrival`, `fromCents`, `roundScore`), а не сервисы —
 * тот же ход, что в 0014, 0018, 0019 и 0026. Именно поэтому дашборд не может
 * разойтись с экранами, на которые с него переходят: он считает те же числа
 * тем же кодом.
 *
 * `PrismaService` — из глобального модуля.
 */
@Module({
  controllers: [DashboardController],
  providers: [DashboardService, DashboardRepository],
  exports: [DashboardService],
})
export class DashboardModule {}
