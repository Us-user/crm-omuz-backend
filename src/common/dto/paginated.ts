import type { ResponseMeta } from '../interfaces/api-response.interface';

/**
 * Результат постраничной выборки. Сервисы возвращают его, а
 * `TransformResponseInterceptor` разворачивает в `{ data, meta }`.
 */
export class Paginated<T> {
  readonly items: T[];
  readonly meta: ResponseMeta;

  /**
   * @param extra доменные поля `meta` сверх пагинации (ТЗ 3.5 прямо допускает
   *   их в `meta`). Нужны там, где у списка есть общая для всех страниц
   *   величина: например баланс коинов рядом с историей начислений (ТЗ 5.9) —
   *   иначе экран запрашивал бы его вторым обращением.
   */
  constructor(
    items: T[],
    total: number,
    page: number,
    limit: number,
    extra?: Record<string, unknown>,
  ) {
    this.items = items;
    this.meta = {
      total,
      page,
      limit,
      totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
      ...extra,
    };
  }

  static from<T>(
    items: T[],
    total: number,
    query: { page: number; limit: number },
    extra?: Record<string, unknown>,
  ): Paginated<T> {
    return new Paginated(items, total, query.page, query.limit, extra);
  }
}
