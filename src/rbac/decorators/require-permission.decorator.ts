import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';

import { PermissionsGuard } from '../guards/permissions.guard';
import type { PermissionCode } from '../permission-catalog';
import { PERMISSIONS_KEY } from '../rbac.constants';

/**
 * Требует права из каталога (ТЗ 3.2, нотация `Permission.<Раздел>.<Действие>`).
 *
 * Метаданные и guard навешиваются вместе: иначе достаточно забыть
 * `@UseGuards(PermissionsGuard)`, и эндпоинт с объявленным правом остался бы
 * открытым для любого сотрудника, а по коду выглядел бы защищённым.
 *
 * При нескольких кодах требуются **все** — см. `PermissionsService.hasPermissions`.
 *
 * Не заменяет `@RequireAccountType(...)`, а дополняет его: тот отделяет
 * сотрудника от студента и берётся из токена, этот проверяет конкретное
 * действие по актуальным данным БД.
 *
 * @example
 * ```ts
 * @RequirePermission('Permission.Students.Promote')
 * promoteToEmployee() {}
 * ```
 */
export const RequirePermission = (...codes: [PermissionCode, ...PermissionCode[]]) =>
  applyDecorators(SetMetadata(PERMISSIONS_KEY, codes), UseGuards(PermissionsGuard));
