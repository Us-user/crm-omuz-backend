import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import request from 'supertest';

import { AllExceptionsFilter, TransformResponseInterceptor } from 'src/common';
import { API_PREFIX, PREFIX_EXCLUDED_ROUTES } from 'src/constants';
import { HealthController } from 'src/health/health.controller';
import { HealthService } from 'src/health/health.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';

/**
 * Проверяет сам маршрут `/health` без внешней инфраструктуры: зависимости
 * подменены заглушками. Сценарий с реальными PostgreSQL/Redis — в `health.e2e-spec.ts`.
 */
describe('Маршрут /health (e2e, зависимости замоканы)', () => {
  let app: INestApplication;
  const redisPing = jest.fn<Promise<void>, []>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: PrismaService, useValue: { ping: () => Promise.resolve() } },
        { provide: RedisService, useValue: { ping: redisPing } },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix(API_PREFIX, { exclude: PREFIX_EXCLUDED_ROUTES });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    redisPing.mockReset();
  });

  it('отвечает 200 и status=up, когда живы все зависимости', async () => {
    redisPing.mockResolvedValue(undefined);

    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body.data).toMatchObject({
      status: 'up',
      uptime: expect.any(Number),
      timestamp: expect.any(String),
    });
    expect(response.body.data.dependencies.database.status).toBe('up');
    expect(response.body.data.dependencies.redis.status).toBe('up');
  });

  it('остаётся 200 со status=degraded, когда упала зависимость', async () => {
    redisPing.mockRejectedValue(new Error('ECONNREFUSED'));

    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body.data.status).toBe('degraded');
    expect(response.body.data.dependencies.redis).toMatchObject({
      status: 'down',
      error: 'ECONNREFUSED',
    });
  });

  it('доступен вне префикса /api/v1', async () => {
    redisPing.mockResolvedValue(undefined);

    await request(app.getHttpServer()).get('/api/v1/health').expect(404);
  });
});
