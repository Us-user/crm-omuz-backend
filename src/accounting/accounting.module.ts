import { Module } from '@nestjs/common';

import { AccountingRepository } from './accounting.repository';
import { BudgetController } from './budget.controller';
import { BudgetService } from './budget.service';
import { DebtorsController } from './debtors.controller';
import { DebtorsService } from './debtors.service';
import { ExpenseCategoriesController } from './expense-categories.controller';
import { ExpenseCategoriesService } from './expense-categories.service';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';
import { PaymentTypesController } from './payment-types.controller';
import { PaymentTypesService } from './payment-types.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PeriodsController } from './periods.controller';
import { PeriodsService } from './periods.service';
import { PeriodGuardService } from './period-guard.service';
import { SalaryController } from './salary.controller';
import { SalaryService } from './salary.service';

/**
 * Бухгалтерия (ТЗ 5.16, доступна только позиции `Director`): платёжный контур,
 * расходы и обзор.
 *
 * Контроллеры в одном модуле — отступление от привычки «модуль на маршрут»,
 * и оно осознанное, как у справочника и истории уровней ментора (0021):
 * у них общий репозиторий и связывающие правила (способ оплаты держится
 * платежами, платёж пересчитывает начисление, долг выводится из тех же двух
 * таблиц). Разведённые модули заставили бы e2e держать в согласии три
 * хранилища ради одного набора правил.
 *
 * Расходы (0030) встали сюда по тому же доводу, а не по соседству: обзор
 * читает **и** начисления, и кассу, и расходы одним набором чисел — вынеси
 * их в свой модуль, и «Income vs Expense» пришлось бы собирать из двух
 * источников, которые e2e держал бы в согласии руками.
 *
 * Зависимостей от других доменных модулей нет: группы, состав, курс и профиль
 * студента читаются собственным репозиторием — так же, как выпускники читают
 * группу (0026), а лиды справочники (0027). Иначе каждому e2e-набору пришлось
 * бы подменять репозитории, которыми он не пользуется (критерий сессии 0006).
 *
 * `PrismaService` — из глобального модуля.
 */
@Module({
  controllers: [
    PaymentTypesController,
    PaymentsController,
    DebtorsController,
    ExpenseCategoriesController,
    ExpensesController,
    BudgetController,
    SalaryController,
    PeriodsController,
    OverviewController,
  ],
  providers: [
    PaymentTypesService,
    PaymentsService,
    DebtorsService,
    ExpenseCategoriesService,
    ExpensesService,
    BudgetService,
    SalaryService,
    PeriodsService,
    PeriodGuardService,
    OverviewService,
    AccountingRepository,
  ],
})
export class AccountingModule {}
