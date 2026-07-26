import { Injectable, Logger } from '@nestjs/common';

import { BusinessRuleException } from '../common';
import type { PermissionCatalogDto, PermissionDto, UpdatePermissionsDto } from './dto';
import type { PermissionSection } from './permission-catalog';
import { PERMISSION_CATALOG, PERMISSION_SECTION_TITLES } from './permission-catalog';
import type { StoredPermission } from './rbac.repository';
import { RbacRepository } from './rbac.repository';

/**
 * `Administration → Permission` (ТЗ 5.15): каталог прав с переключателем.
 *
 * Состав и порядок берутся из каталога в **коде** (он источник истины, решение
 * сессии 0005), а из БД приходит только состояние `isEnabled` и описание. Права,
 * оставшиеся в таблице от прошлых версий приложения, на экран не попадают:
 * доступа они не дают (`PermissionsService` их отбрасывает), и переключатель
 * рядом с мёртвым правом вводил бы администратора в заблуждение.
 *
 * Выключение действует немедленно и для всех позиций — guard читает права
 * из БД на каждый запрос, кэша нет.
 */
@Injectable()
export class PermissionCatalogAdminService {
  private readonly logger = new Logger('PermissionCatalog');

  constructor(private readonly repository: RbacRepository) {}

  async getCatalog(section?: PermissionSection): Promise<PermissionCatalogDto> {
    const stored = await this.repository.findAllPermissions();
    const byCode = new Map(stored.map((permission) => [permission.code, permission]));

    const grouped = new Map<PermissionSection, PermissionDto[]>();
    const absent: string[] = [];
    let total = 0;

    for (const definition of PERMISSION_CATALOG) {
      if (section !== undefined && definition.section !== section) continue;

      const row = byCode.get(definition.code);
      if (!row) {
        // Строку создаёт синхронизация при старте; её отсутствие — авария,
        // а не обычный случай: переключать нечего, поэтому право не показываем.
        absent.push(definition.code);
        continue;
      }

      const permissions = grouped.get(definition.section) ?? [];
      permissions.push(toPermission(row));
      grouped.set(definition.section, permissions);
      total += 1;
    }

    if (absent.length > 0) {
      this.logger.warn(
        `Права есть в каталоге кода, но отсутствуют в БД (синхронизация не отработала): ${absent.join(', ')}`,
      );
    }

    return {
      total,
      sections: [...grouped.entries()].map(([key, permissions]) => ({
        section: key,
        title: PERMISSION_SECTION_TITLES[key],
        permissions,
      })),
    };
  }

  async update(dto: UpdatePermissionsDto): Promise<PermissionCatalogDto> {
    const stored = await this.repository.findAllPermissions();
    const byCode = new Map(stored.map((permission) => [permission.code, permission]));

    const seen = new Set<string>();
    const enable: string[] = [];
    const disable: string[] = [];

    for (const { code, isEnabled } of dto.permissions) {
      // Два указания на один код означали бы, что результат зависит от порядка
      // в теле запроса, — такой запрос лучше отклонить целиком.
      if (seen.has(code)) {
        throw new BusinessRuleException(`Право указано в запросе дважды: ${code}`);
      }
      seen.add(code);

      const row = byCode.get(code);
      if (!row) {
        throw new BusinessRuleException(`Право отсутствует в каталоге базы данных: ${code}`);
      }

      if (row.isSystem && !isEnabled) {
        throw new BusinessRuleException(
          `Служебное право нельзя выключить: ${code}. ` +
            'Иначе управление каталогом прав нельзя было бы вернуть через API',
        );
      }

      if (row.isEnabled === isEnabled) continue;

      (isEnabled ? enable : disable).push(row.id);
    }

    const changed = await this.repository.setPermissionsEnabled(enable, disable);

    this.logger.log(
      `Каталог прав изменён: включено ${String(enable.length)}, ` +
        `выключено ${String(disable.length)}, строк затронуто ${String(changed)}`,
    );

    return this.getCatalog();
  }
}

const toPermission = (row: StoredPermission): PermissionDto => ({
  id: row.id,
  code: row.code,
  section: row.section,
  action: row.action,
  description: row.description,
  isEnabled: row.isEnabled,
  isSystem: row.isSystem,
});
