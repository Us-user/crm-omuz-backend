import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';

import type { RateLimitRule } from '../rate-limit';
import { RATE_LIMIT_KEY } from '../rate-limit';
import { RateLimitGuard } from '../rate-limit.guard';

/**
 * Ограничивает частоту обращений к эндпоинту (ТЗ 3.8).
 *
 * Правило и guard навешиваются вместе — приём `@RequirePermission` (0005):
 * иначе достаточно забыть `@UseGuards(RateLimitGuard)`, и эндпоинт
 * с объявленным лимитом остался бы без него, а по коду выглядел бы
 * защищённым.
 *
 * Готовые правила лежат в `rate-limit.constants.ts`: числа должны стоять
 * рядом друг с другом, чтобы их можно было сравнить одним взглядом,
 * а не собирать по контроллерам.
 *
 * @example
 * ```ts
 * @RateLimit(LOGIN_RATE_LIMIT)
 * login() {}
 * ```
 */
export const RateLimit = (rule: RateLimitRule) =>
  applyDecorators(SetMetadata(RATE_LIMIT_KEY, rule), UseGuards(RateLimitGuard));
