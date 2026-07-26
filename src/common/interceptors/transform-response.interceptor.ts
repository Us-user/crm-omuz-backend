import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

import { Paginated } from '../dto/paginated';
import type { ApiSuccessResponse } from '../interfaces/api-response.interface';

/**
 * Приводит любой успешный ответ к единому виду `{ data, meta }` (ТЗ 3.5).
 * `Paginated` разворачивается в `data` + `meta` с пагинацией.
 */
@Injectable()
export class TransformResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiSuccessResponse<unknown>
> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessResponse<unknown>> {
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
