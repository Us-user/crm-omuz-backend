import { Module } from '@nestjs/common';

import { EmployeesController } from './employees.controller';
import { EmployeesRepository } from './employees.repository';
import { EmployeesService } from './employees.service';

/**
 * Сотрудники (ТЗ 5.14): CRUD с формой «Employer», фильтры списка и позиции
 * как роли доступа (ТЗ 3.2).
 *
 * Отдельный модуль, а не рост `RbacAdminModule`, хотя оба пишут в
 * `EmployeePosition`: там управление **правами** (позиции, каталог, роли
 * аккаунтов), здесь — кадровая карточка. Общее между ними — правило
 * «последнего `Director` не тронуть», и оно живёт не в общем сервисе,
 * а в константе имени позиции: сервис с DI заставил бы каждый e2e-набор
 * подменять репозиторий, которым он не пользуется (критерий сессии 0006).
 *
 * `PhoneService`, `PermissionsService` и `PrismaService` — из глобальных модулей.
 */
@Module({
  controllers: [EmployeesController],
  providers: [EmployeesService, EmployeesRepository],
})
export class EmployeesModule {}
