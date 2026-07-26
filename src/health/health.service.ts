import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { HealthCheckDto, HealthStatus, type DependencyHealth } from './dto/health-check.dto';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async check(): Promise<HealthCheckDto> {
    const [database, redis] = await Promise.all([
      this.probe(() => this.prisma.ping()),
      this.probe(() => this.redis.ping()),
    ]);

    const dependencies = { database, redis };
    const allUp = Object.values(dependencies).every((d) => d.status === HealthStatus.Up);

    return {
      status: allUp ? HealthStatus.Up : HealthStatus.Degraded,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      dependencies,
    };
  }

  private async probe(fn: () => Promise<unknown>): Promise<DependencyHealth> {
    const startedAt = Date.now();
    try {
      await fn();
      return { status: HealthStatus.Up, latencyMs: Date.now() - startedAt };
    } catch (error: unknown) {
      return {
        status: HealthStatus.Down,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
