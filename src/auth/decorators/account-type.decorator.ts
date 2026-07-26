import { SetMetadata } from '@nestjs/common';
import type { AccountType } from '@prisma/client';

import { ACCOUNT_TYPES_KEY } from '../auth.constants';

/**
 * Допускает к эндпоинту только перечисленные типы аккаунта.
 *
 * Грубый фильтр «сотрудник или студент»: полномочия студента — только просмотр
 * своих данных (ТЗ 3.2). Работает рядом с `@RequirePermission(...)`, а не вместо
 * него: тип берётся из access-токена и отсекает чужую половину пользователей
 * без запроса в БД, а конкретное действие проверяется правом из каталога.
 *
 * Работает в паре с `AccountTypeGuard` — сам по себе метаданные не проверяет.
 */
export const RequireAccountType = (...types: AccountType[]) =>
  SetMetadata(ACCOUNT_TYPES_KEY, types);
