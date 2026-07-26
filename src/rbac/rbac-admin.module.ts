import { Module } from '@nestjs/common';

import { AdminPermissionsController } from './admin-permissions.controller';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersRepository } from './admin-users.repository';
import { AdminUsersService } from './admin-users.service';
import { PermissionCatalogAdminService } from './permission-catalog-admin.service';
import { PositionsController } from './positions.controller';
import { PositionsRepository } from './positions.repository';
import { PositionsService } from './positions.service';

/**
 * HTTP-поверхность RBAC: справочник позиций (ТЗ 5.14) и экраны
 * `Administration → Users` / `Administration → Permission` (ТЗ 5.15).
 *
 * Отдельно от `RbacModule` и **не** глобальный: тот несёт сквозное ядро
 * (каталог прав, `PermissionsService`, guard) и импортируется всюду, включая
 * тесты, которым контроллеры и их репозитории не нужны. Здесь же — только
 * управление правами, и зависит этот модуль лишь от Prisma
 * и от `RbacRepository`, который экспортирует глобальное ядро.
 */
@Module({
  controllers: [PositionsController, AdminUsersController, AdminPermissionsController],
  providers: [
    PositionsRepository,
    PositionsService,
    AdminUsersRepository,
    AdminUsersService,
    PermissionCatalogAdminService,
  ],
})
export class RbacAdminModule {}
