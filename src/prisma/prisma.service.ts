import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { AppConfigService } from '../config';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfigService) {
    super({
      datasourceUrl: config.databaseUrl,
      log: ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Подключение к PostgreSQL установлено');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Проверка живости соединения для `GET /health`. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
