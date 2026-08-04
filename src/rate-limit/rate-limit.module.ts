import { Global, Module } from '@nestjs/common';

import { RateLimitGuard } from './rate-limit.guard';
import { RateLimitService } from './rate-limit.service';

/**
 * Ограничение частоты запросов (ТЗ 3.8).
 *
 * Глобальный по тому же доводу, что `RbacModule` (0005): `@RateLimit(...)`
 * навешивает guard на эндпоинт любого модуля, и требовать от каждого
 * импортировать лимитер — лишний шаг, который однажды забудут (guard тогда
 * не соберётся в рантайме).
 *
 * `RedisModule` **не импортируется**: клиент у `RateLimitService`
 * необязателен. В `AppModule` он есть всегда (модуль глобальный), а без него
 * лимитер честно ничего не считает — то же самое поведение, что при упавшем
 * Redis. Благодаря этому e2e-набор, которому лимиты не нужны, добавляет
 * `RateLimitModule` одной строкой и не поднимает ни настоящего Redis,
 * ни его подмены.
 */
@Global()
@Module({
  providers: [RateLimitService, RateLimitGuard],
  exports: [RateLimitService, RateLimitGuard],
})
export class RateLimitModule {}
