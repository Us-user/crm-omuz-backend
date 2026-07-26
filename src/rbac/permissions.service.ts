import { Injectable } from '@nestjs/common';

import type { PermissionCode } from './permission-catalog';
import { isPermissionCode } from './permission-catalog';
import { RbacRepository } from './rbac.repository';

/**
 * Права текущего пользователя (ТЗ 3.2): union прав всех позиций его сотрудника.
 *
 * Права **не кладутся в access-токен**: токен живёт час, и снятая позиция
 * действовала бы ещё час после снятия — для системы с разделом «Бухгалтерия»
 * это неприемлемо. Поэтому набор читается из БД на каждый защищённый запрос:
 * один индексный запрос против отзыва прав, который срабатывает сразу.
 * Кэш в Redis (с инвалидацией при смене позиций) — оптимизация Фазы 14,
 * и она не должна появиться раньше, чем понадобится.
 */
@Injectable()
export class PermissionsService {
  constructor(private readonly repository: RbacRepository) {}

  /**
   * @param accountId аккаунт из access-токена.
   * @returns коды прав; у студента и у сотрудника без позиций — пустое множество.
   */
  async getAccountPermissions(accountId: string): Promise<ReadonlySet<PermissionCode>> {
    const rows = await this.repository.findAccountPermissionCodes(accountId);
    const granted = new Set<PermissionCode>();

    for (const { code } of rows) {
      // Код, которого нет в каталоге, — след от прошлой версии приложения
      // (синхронизация такие строки не удаляет, чтобы не терять выданные галочки).
      // Раз в коде на него никто не ссылается, доступа он давать не должен.
      if (isPermissionCode(code)) granted.add(code);
    }

    return granted;
  }

  /**
   * Требуются **все** перечисленные права, а не любое из них: при перечислении
   * нескольких кодов ожидание «и то, и другое» безопаснее, чем «хоть что-нибудь».
   */
  async hasPermissions(accountId: string, required: readonly PermissionCode[]): Promise<boolean> {
    if (required.length === 0) return true;

    const granted = await this.getAccountPermissions(accountId);

    return required.every((code) => granted.has(code));
  }
}
