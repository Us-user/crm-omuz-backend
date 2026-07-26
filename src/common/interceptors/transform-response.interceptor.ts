import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, map } from 'rxjs';

import { Paginated } from '../dto/paginated';
import type { ApiSuccessResponse } from '../interfaces/api-response.interface';
import { RAW_RESPONSE_KEY } from './raw-response.decorator';

/**
 * Приводит любой успешный ответ к единому виду `{ data, meta }` (ТЗ 3.5).
 * `Paginated` разворачивается в `data` + `meta` с пагинацией.
 *
 * Эндпоинты, помеченные `@RawResponse()`, проходят мимо: файл отдаётся как есть.
 */
@Injectable()
export class TransformResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiSuccessResponse<unknown> | T
> {
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessResponse<unknown> | T> {
    const raw = this.reflector.getAllAndOverride<boolean | undefined>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (raw === true) {
      return next.handle();
    }

    return next.handle().pipe(
      map((payload) => {
        if (payload instanceof Paginated) {
          return { data: payload.items, meta: payload.meta };
        }
        return { data: payload ?? null };
      }),
    );
  }
}
