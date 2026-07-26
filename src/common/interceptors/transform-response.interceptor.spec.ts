import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';

import { Paginated } from '../dto/paginated';
import { RawResponse } from './raw-response.decorator';
import { TransformResponseInterceptor } from './transform-response.interceptor';

class Wrapped {
  wrapped(): string {
    return 'ok';
  }

  @RawResponse()
  raw(): string {
    return 'ok';
  }
}

/** Контекст с настоящим обработчиком — метаданные `@RawResponse()` читаются с него. */
const contextOf = (handler: () => unknown): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => Wrapped,
  }) as unknown as ExecutionContext;

const handlerOf = <T>(value: T): CallHandler<T> => ({ handle: () => of(value) });

describe('TransformResponseInterceptor', () => {
  const interceptor = new TransformResponseInterceptor(new Reflector());
  const context = contextOf(Wrapped.prototype.wrapped);

  it('оборачивает обычный результат в { data }', async () => {
    const result = await firstValueFrom(
      interceptor.intercept(context, handlerOf({ id: 1, title: 'Курс' })),
    );

    expect(result).toEqual({ data: { id: 1, title: 'Курс' } });
  });

  it('разворачивает Paginated в { data, meta }', async () => {
    const page = new Paginated(['a', 'b'], 42, 2, 20);

    const result = await firstValueFrom(interceptor.intercept(context, handlerOf(page)));

    expect(result).toEqual({
      data: ['a', 'b'],
      meta: { total: 42, page: 2, limit: 20, totalPages: 3 },
    });
  });

  it('превращает undefined в data: null', async () => {
    const result = await firstValueFrom(interceptor.intercept(context, handlerOf(undefined)));

    expect(result).toEqual({ data: null });
  });

  it('не трогает ответ, помеченный @RawResponse()', async () => {
    const csv = 'Телефон,Фамилия\r\n+992901234567,Каримова\r\n';

    const result = await firstValueFrom(
      interceptor.intercept(contextOf(Wrapped.prototype.raw), handlerOf(csv)),
    );

    expect(result).toBe(csv);
  });
});
