import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { AppConfigService } from '../config';

/**
 * Единый клиент Redis: кэш, rate-limit (Фаза 14) и проверка живости в `/health`.
 * Очереди BullMQ держат собственные соединения (см. `QueueModule`).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(config: AppConfigService) {
    const { host, port, password, db } = config.redis;

    this.client = new Redis({
      host,
      port,
      password,
      db,
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      // Не «затапливаем» логи при недоступном Redis: пауза растёт до 10 секунд.
      retryStrategy: (times) => Math.min(times * 500, 10_000),
    });

    this.client.on('error', (error: Error) => {
      this.logger.warn(`Redis недоступен: ${error.message}`);
    });

    this.client.connect().catch((error: unknown) => {
      this.logger.warn(
        `Не удалось подключиться к Redis: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** Проверка живости соединения для `GET /health`. */
  async ping(): Promise<void> {
    const reply: string = await this.client.ping();
    if (reply !== 'PONG') {
      throw new Error(`Неожиданный ответ Redis: ${reply}`);
    }
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
