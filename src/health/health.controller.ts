import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiDataResponse } from '../common';
import { HealthCheckDto } from './dto/health-check.dto';
import { HealthService } from './health.service';

/**
 * `GET /health` намеренно вынесен из префикса `/api/v1` — это служебный эндпоинт
 * для балансировщика и мониторинга, он не версионируется.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Проверка живости приложения и его зависимостей' })
  @ApiDataResponse(HealthCheckDto, { description: 'Состояние сервиса' })
  check(): Promise<HealthCheckDto> {
    return this.health.check();
  }
}
