import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum HealthStatus {
  Up = 'up',
  Down = 'down',
  Degraded = 'degraded',
}

export class DependencyHealth {
  @ApiProperty({ enum: HealthStatus, example: HealthStatus.Up })
  status!: HealthStatus;

  @ApiProperty({ description: 'Время ответа проверки, мс', example: 3 })
  latencyMs!: number;

  @ApiPropertyOptional({ description: 'Текст ошибки, если зависимость недоступна' })
  error?: string;
}

export class HealthDependenciesDto {
  @ApiProperty({ type: DependencyHealth })
  database!: DependencyHealth;

  @ApiProperty({ type: DependencyHealth })
  redis!: DependencyHealth;
}

export class HealthCheckDto {
  @ApiProperty({
    enum: HealthStatus,
    description: '`up` — все зависимости живы, `degraded` — хотя бы одна недоступна',
  })
  status!: HealthStatus;

  @ApiProperty({ description: 'Аптайм процесса, сек', example: 421 })
  uptime!: number;

  @ApiProperty({ example: '2026-07-26T10:15:00.000Z' })
  timestamp!: string;

  @ApiProperty({ type: HealthDependenciesDto })
  dependencies!: HealthDependenciesDto;
}
