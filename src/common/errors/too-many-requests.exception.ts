import { HttpException, HttpStatus } from '@nestjs/common';

import { ErrorCode } from './error-code.enum';

/**
 * Превышен лимит запросов → HTTP 429 (ТЗ 3.5, 3.8).
 *
 * Своего исключения на этот код Nest не даёт, а `ErrorCode.TooManyRequests`
 * лежит в перечне с Фазы 0 и до Фазы 14 никем не бросался.
 *
 * `retryAfterSeconds` попадает и в `details`, и в заголовок `Retry-After`
 * (его ставит `RateLimitGuard`): первое читает фронт, второе — прокси и curl.
 */
export class TooManyRequestsException extends HttpException {
  constructor(retryAfterSeconds: number) {
    super(
      {
        code: ErrorCode.TooManyRequests,
        message: 'Слишком много запросов. Повторите позже',
        details: { retryAfterSeconds },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
