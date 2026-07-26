import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';
import { HealthStatus } from './dto/health-check.dto';
import { HealthService } from './health.service';

const makeService = (prismaPing: () => Promise<void>, redisPing: () => Promise<void>) =>
  new HealthService(
    { ping: prismaPing } as unknown as PrismaService,
    { ping: redisPing } as unknown as RedisService,
  );

describe('HealthService', () => {
  it('возвращает up, когда живы обе зависимости', async () => {
    const service = makeService(
      () => Promise.resolve(),
      () => Promise.resolve(),
    );

    const result = await service.check();

    expect(result.status).toBe(HealthStatus.Up);
    expect(result.dependencies.database.status).toBe(HealthStatus.Up);
    expect(result.dependencies.redis.status).toBe(HealthStatus.Up);
  });

  it('возвращает degraded и текст ошибки, когда Redis недоступен', async () => {
    const service = makeService(
      () => Promise.resolve(),
      () => Promise.reject(new Error('ECONNREFUSED')),
    );

    const result = await service.check();

    expect(result.status).toBe(HealthStatus.Degraded);
    expect(result.dependencies.database.status).toBe(HealthStatus.Up);
    expect(result.dependencies.redis.status).toBe(HealthStatus.Down);
    expect(result.dependencies.redis.error).toBe('ECONNREFUSED');
  });

  it('не падает, когда недоступна база', async () => {
    const service = makeService(
      () => Promise.reject(new Error('no connection')),
      () => Promise.resolve(),
    );

    const result = await service.check();

    expect(result.status).toBe(HealthStatus.Degraded);
    expect(result.dependencies.database.status).toBe(HealthStatus.Down);
  });
});
