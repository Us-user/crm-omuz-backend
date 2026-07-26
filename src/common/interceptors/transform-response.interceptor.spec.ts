import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';

import { Paginated } from '../dto/paginated';
import { TransformResponseInterceptor } from './transform-response.interceptor';

const context = {} as ExecutionContext;

const handlerOf = <T>(value: T): CallHandler<T> => ({ handle: () => of(value) });

describe('TransformResponseInterceptor', () => {
  const interceptor = new TransformResponseInterceptor();

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
});
