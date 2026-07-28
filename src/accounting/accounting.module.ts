import { Module } from '@nestjs/common';

import { AccountingRepository } from './accounting.repository';
import { DebtorsController } from './debtors.controller';
import { DebtorsService } from './debtors.service';
import { PaymentTypesController } from './payment-types.controller';
import { PaymentTypesService } from './payment-types.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * Бухгалтерия: платёжный контур (ТЗ 5.16, доступен только позиции `Director`).
 *
 * Три контроллера в одном модуле — отступление от привычки «модуль на маршрут»,
 * и оно осознанное, как у справочника и истории уровней ментора (0021):
 * у них общий репозиторий и связывающие правила (способ оплаты держится
 * платежами, платёж пересчитывает начисление, долг выводится из тех же двух
 * таблиц). Разведённые модули заставили бы e2e держать в согласии три
 * хранилища ради одного набора правил.
 *
 * Зависимостей от других доменных модулей нет: группы, состав, курс и профиль
 * студента читаются собственным репозиторием — так же, как выпускники читают
 * группу (0026), а лиды справочники (0027). Иначе каждому e2e-набору пришлось
 * бы подменять репозитории, которыми он не пользуется (критерий сессии 0006).
 *
 * `PrismaService` — из глобального модуля.
 */
@Module({
  controllers: [PaymentTypesController, PaymentsController, DebtorsController],
  providers: [PaymentTypesService, PaymentsService, DebtorsService, AccountingRepository],
})
export class AccountingModule {}
