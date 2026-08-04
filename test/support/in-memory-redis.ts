import type { RedisService } from 'src/redis/redis.service';

/**
 * Redis в памяти — ровно настолько, насколько его использует `RateLimitService`:
 * `EVAL` со скриптом счётчика и `DEL`.
 *
 * Подменяется **клиент**, а не сам лимитер: так в наборе работает настоящий
 * `RateLimitService` со своими ключами, разбором ответа и fail-open, и e2e
 * проверяет то же, что поедет в прод. Не проверенным остаётся ровно одно —
 * выполнение Lua-скрипта настоящим Redis (тот же честный пробел, что у Prisma
 * в остальных наборах, 0029–0039).
 *
 * Счётчик заводится заново на каждый набор, поэтому лимиты внутри теста
 * не «протекают» в соседний.
 */
export class InMemoryRedis {
  private readonly counters = new Map<string, { hits: number; expiresAt: number }>();

  /** Что должен вернуть очередной вызов вместо счёта: имитация недоступности. */
  failWith: Error | null = null;

  readonly client = {
    eval: (_script: string, _numKeys: number, key: string, windowMs: string): Promise<unknown> => {
      if (this.failWith) return Promise.reject(this.failWith);

      const now = Date.now();
      const existing = this.counters.get(key);
      const alive = existing && existing.expiresAt > now ? existing : undefined;

      // Повторяет скрипт: INCR, а срок ставится только на первом обращении.
      const counter = alive ?? { hits: 0, expiresAt: now + Number(windowMs) };
      counter.hits += 1;
      this.counters.set(key, counter);

      return Promise.resolve([counter.hits, counter.expiresAt - now]);
    },

    del: (key: string): Promise<number> => {
      if (this.failWith) return Promise.reject(this.failWith);

      return Promise.resolve(this.counters.delete(key) ? 1 : 0);
    },
  };

  /** Сколько обращений засчитано ключам, начинающимся с префикса. */
  hitsMatching(prefix: string): number {
    let total = 0;
    for (const [key, counter] of this.counters) {
      if (key.startsWith(prefix)) total += counter.hits;
    }

    return total;
  }

  asRedisService(): RedisService {
    return this as unknown as RedisService;
  }
}
