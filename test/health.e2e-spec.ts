import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from 'src/app.module';
import { configureApp } from 'src/bootstrap';

/**
 * Требует поднятой инфраструктуры (PostgreSQL; Redis опционален — при его
 * отсутствии `status` будет `degraded`, но эндпоинт обязан отвечать 200).
 */
describe('GET /health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('отвечает 200 и оборачивает тело в { data }', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body).toHaveProperty('data');
    expect(response.body.data).toMatchObject({
      status: expect.stringMatching(/^(up|degraded)$/),
      uptime: expect.any(Number),
      timestamp: expect.any(String),
    });
    expect(response.body.data.dependencies.database.status).toBe('up');
  });

  it('доступен вне префикса /api/v1', async () => {
    await request(app.getHttpServer()).get('/api/v1/health').expect(404);
  });
});
