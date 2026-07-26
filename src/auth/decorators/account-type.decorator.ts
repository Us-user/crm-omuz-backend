import { SetMetadata } from '@nestjs/common';
import type { AccountType } from '@prisma/client';

import { ACCOUNT_TYPES_KEY } from '../auth.constants';

/**
 * Допускает к эндпоинту только перечисленные типы аккаунта.
 *
 * Это грубая заготовка проверки прав до Фазы 2: полномочия студента —
 * только просмотр своих данных (ТЗ 3.2), поэтому административные действия
 * отсекаются уже сейчас. С появлением каталога прав рядом встанет
 * `@RequirePermission('Permission.<Раздел>.<Действие>')`, а этот декоратор
 * останется грубым фильтром «сотрудник или студент».
 *
 * Работает в паре с `AccountTypeGuard` — сам по себе метаданные не проверяет.
 */
export const RequireAccountType = (...types: AccountType[]) =>
  SetMetadata(ACCOUNT_TYPES_KEY, types);
