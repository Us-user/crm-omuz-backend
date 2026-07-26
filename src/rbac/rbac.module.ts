import { Global, Module } from '@nestjs/common';

import { PermissionCatalogSyncService } from './permission-catalog-sync.service';
import { PermissionsService } from './permissions.service';
import { PermissionsGuard } from './guards/permissions.guard';
import { RbacRepository } from './rbac.repository';

/**
 * Роли, позиции и права (ТЗ 3.2, 5.15).
 *
 * Глобальный: `@RequirePermission(...)` навешивает `PermissionsGuard` на эндпоинты
 * любого доменного модуля, и требовать от каждого из них импортировать RBAC —
 * лишний шаг, который однажды забудут (guard тогда не соберётся в рантайме).
 *
 * CRUD позиций и экраны Administration подключаются следующим куском Фазы 2.
 */
@Global()
@Module({
  providers: [RbacRepository, PermissionsService, PermissionsGuard, PermissionCatalogSyncService],
  exports: [PermissionsService, PermissionsGuard],
})
export class RbacModule {}
