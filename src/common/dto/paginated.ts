import type { ResponseMeta } from '../interfaces/api-response.interface';

/**
 * Результат постраничной выборки. Сервисы возвращают его, а
 * `TransformResponseInterceptor` разворачивает в `{ data, meta }`.
 */
export class Paginated<T> {
  readonly items: T[];
  readonly meta: ResponseMeta;

  constructor(items: T[], total: number, page: number, limit: number) {
    this.items = items;
    this.meta = {
      total,
      page,
      limit,
      totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
    };
  }

  static from<T>(items: T[], total: number, query: { page: number; limit: number }): Paginated<T> {
    return new Paginated(items, total, query.page, query.limit);
  }
}
