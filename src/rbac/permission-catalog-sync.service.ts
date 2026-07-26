import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { DEFAULT_POSITIONS, DIRECTOR_POSITION_NAME } from './rbac.constants';
import type { PermissionDefinition } from './permission-catalog';
import { PERMISSION_CATALOG } from './permission-catalog';
import type { StoredPermission } from './rbac.repository';
import { RbacRepository } from './rbac.repository';

/** Что синхронизация сделала с таблицей — возвращается ради теста и строки в логе. */
export interface CatalogSyncResult {
  created: number;
  updated: number;
  /** Права в БД, которых больше нет в каталоге: не удаляются, но и не действуют. */
  stale: string[];
  /** Сколько прав добавлено системной позиции `Director`. */
  grantedToDirector: number;
}

/**
 * Приводит таблицу `permissions` к каталогу из кода при старте приложения (ТЗ 3.2, 5.15).
 *
 * Почему при старте, а не миграцией: каталог растёт с каждой фазой, и права
 * должны появляться вместе с эндпоинтами, которые их требуют. Миграция на каждый
 * новый код быстро превратилась бы в ручную рутину, где легко разойтись с кодом.
 *
 * Что синхронизация **не** делает:
 * - не трогает `isEnabled` — это переключатель администратора (ТЗ 5.15);
 * - не удаляет права, исчезнувшие из каталога, — вместе с ними каскадом ушли бы
 *   выданные позициям галочки. Такие права просто перестают действовать
 *   (`PermissionsService` их отбрасывает), а в лог уходит предупреждение.
 */
@Injectable()
export class PermissionCatalogSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger('PermissionCatalog');

  constructor(private readonly repository: RbacRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    const result = await this.sync();

    this.logger.log(
      `Каталог прав синхронизирован: всего ${PERMISSION_CATALOG.length}, ` +
        `добавлено ${result.created}, обновлено ${result.updated}, ` +
        `выдано позиции ${DIRECTOR_POSITION_NAME} ${result.grantedToDirector}.`,
    );

    if (result.stale.length > 0) {
      this.logger.warn(
        `Права есть в БД, но их нет в каталоге кода — доступа они не дают: ${result.stale.join(', ')}`,
      );
    }
  }

  async sync(): Promise<CatalogSyncResult> {
    const stored = await this.repository.findAllPermissions();
    const byCode = new Map(stored.map((permission) => [permission.code, permission]));

    const missing = PERMISSION_CATALOG.filter((definition) => !byCode.has(definition.code));
    const created = missing.length > 0 ? await this.repository.createPermissions(missing) : 0;

    let updated = 0;
    for (const definition of PERMISSION_CATALOG) {
      const existing = byCode.get(definition.code);
      if (existing && this.differs(existing, definition)) {
        await this.repository.updatePermission(existing.id, definition);
        updated += 1;
      }
    }

    const catalogCodes = new Set<string>(PERMISSION_CATALOG.map((d) => d.code));
    const stale = stored.map((p) => p.code).filter((code) => !catalogCodes.has(code));

    const director = DEFAULT_POSITIONS.find(({ name }) => name === DIRECTOR_POSITION_NAME);
    const grantedToDirector = await this.repository.syncSystemPosition(
      DIRECTOR_POSITION_NAME,
      director?.description ?? DIRECTOR_POSITION_NAME,
    );

    return { created, updated, stale, grantedToDirector };
  }

  private differs(stored: StoredPermission, definition: PermissionDefinition): boolean {
    return (
      stored.section !== definition.section ||
      stored.action !== definition.action ||
      stored.description !== definition.description ||
      stored.isSystem !== definition.isSystem
    );
  }
}
