import { Injectable, Logger, Optional } from '@nestjs/common';

import { RedisService } from '../redis/redis.service';
import type { RateLimitWindow } from './rate-limit';
import { isExceeded, retryAfterSeconds } from './rate-limit';

/**
 * Счётчик с фиксированным окном, одной командой и без гонок.
 *
 * `INCR` + `PEXPIRE` двумя запросами оставили бы окно, в котором ключ уже
 * посчитан, а срока ещё не получил: упади соединение между ними — счётчик
 * останется навсегда, и человек не войдёт уже никогда. `EVAL` выполняет обе
 * команды атомарно, а заодно возвращает остаток срока тем же ответом.
 */
const HIT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { hits, redis.call('PTTL', KEYS[1]) }
`;

/** Как часто повторять в логе жалобу на недоступный Redis. */
const DEGRADED_LOG_INTERVAL_MS = 60_000;

/** Итог обращения к счётчику. */
export interface RateLimitVerdict {
  /** Лимит исчерпан — запрос отбивается 429. */
  readonly exceeded: boolean;
  /** Сколько ждать до следующей попытки (для `Retry-After`). */
  readonly retryAfterSeconds: number;
  /**
   * Счётчик не сработал, потому что Redis недоступен. Запрос при этом
   * **пропускается** — см. решение о fail-open ниже.
   */
  readonly degraded: boolean;
}

/** Счётчик не сработал — запрос идёт дальше, но это отмечено (см. fail-open ниже). */
const DEGRADED: RateLimitVerdict = { exceeded: false, retryAfterSeconds: 0, degraded: true };

/**
 * Ограничение частоты запросов на Redis (ТЗ 3.8).
 *
 * **Недоступный Redis пропускает запрос** (fail-open, решение пользователя,
 * сессия 0040). Довод: лимит здесь — второй рубеж поверх argon2id (0002)
 * и поверх лимита «3 кода в час», который живёт в таблице (0003), а падение
 * кэша не должно останавливать работу центра — никто не войдёт в CRM, пока
 * кто-то не поднимет Redis. Цена названа прямо: в минуты недоступности
 * перебор ничем не ограничен, и об этом кричит лог.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private degradedLoggedAt = 0;

  /**
   * Redis необязателен, и это то же самое решение fail-open, только на этапе
   * сборки модуля: без клиента считать негде, и лимитер честно ничего не
   * ограничивает вместо того, чтобы уронить приложение. В `AppModule`
   * клиент есть всегда (`RedisModule` глобальный); отсутствовать он может
   * в тестовом наборе, которому лимиты не нужны.
   */
  constructor(@Optional() private readonly redis?: RedisService) {
    if (!redis) {
      this.logger.warn(
        'Клиент Redis не подключён — ограничение частоты запросов не действует (ТЗ 3.8)',
      );
    }
  }

  /** Засчитывает обращение и говорит, исчерпан ли лимит. */
  async hit(key: string, window: RateLimitWindow): Promise<RateLimitVerdict> {
    if (!this.redis) return DEGRADED;

    try {
      const reply: unknown = await this.redis.client.eval(
        HIT_SCRIPT,
        1,
        key,
        String(window.windowSeconds * 1000),
      );

      const [hits, ttlMs] = parseHitReply(reply);

      return {
        exceeded: isExceeded(hits, window.limit),
        retryAfterSeconds: retryAfterSeconds(ttlMs, window.windowSeconds),
        degraded: false,
      };
    } catch (error: unknown) {
      this.reportDegraded(error);
      return DEGRADED;
    }
  }

  /**
   * Сбрасывает счётчик. Нужен ровно одному сценарию — успешному входу
   * (`AuthService.login`): человек, который вспомнил пароль после пары
   * опечаток, не должен доживать окно с почти исчерпанным лимитом.
   */
  async reset(key: string): Promise<void> {
    if (!this.redis) return;

    try {
      await this.redis.client.del(key);
    } catch (error: unknown) {
      this.reportDegraded(error);
    }
  }

  /**
   * Жалоба на недоступный Redis — не чаще раза в минуту. Лимитер вызывается
   * на каждый запрос входа, и без этого первая же недоступность залила бы лог
   * (тот же приём, что у `retryStrategy` клиента, 0001).
   */
  private reportDegraded(error: unknown): void {
    const now = Date.now();
    if (now - this.degradedLoggedAt < DEGRADED_LOG_INTERVAL_MS) return;
    this.degradedLoggedAt = now;

    this.logger.warn(
      'Ограничение частоты запросов не сработало (Redis недоступен либо ответил неожиданно) — ' +
        `запросы пропускаются без счёта. Причина: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Разбирает ответ скрипта. Lua отдаёт массив из двух целых, но тип ioredis —
 * `unknown`, а неожиданный ответ не должен превращаться в `NaN`, который
 * «не больше лимита» и потому молча открыл бы эндпоинт.
 */
function parseHitReply(reply: unknown): [hits: number, ttlMs: number] {
  if (!Array.isArray(reply)) {
    throw new TypeError(`Неожиданный ответ Redis на счётчик лимита: ${JSON.stringify(reply)}`);
  }

  const hits = Number(reply[0]);
  const ttlMs = Number(reply[1]);

  if (!Number.isFinite(hits)) {
    throw new TypeError(`Неожиданное число обращений в ответе Redis: ${String(reply[0])}`);
  }

  return [hits, ttlMs];
}
