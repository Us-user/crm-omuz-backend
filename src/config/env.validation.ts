import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export enum LogLevel {
  Trace = 'trace',
  Debug = 'debug',
  Info = 'info',
  Warn = 'warn',
  Error = 'error',
  Fatal = 'fatal',
  /** Полностью отключает вывод — используется в тестах. */
  Silent = 'silent',
}

/** Приводит `"true"/"1"` к `true`, `"false"/"0"` к `false`. */
const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  return value;
};

const toInt = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

/**
 * Схема переменных окружения. Приложение не стартует, пока значения не валидны —
 * это защищает от «тихих» ошибок конфигурации в проде (ТЗ 3.8).
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  // --- PostgreSQL ---
  @IsString()
  @MinLength(1)
  DATABASE_URL!: string;

  // --- Redis ---
  @IsString()
  @MinLength(1)
  REDIS_HOST: string = '127.0.0.1';

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(65535)
  REDIS_PORT: number = 6379;

  @IsOptional()
  @IsString()
  REDIS_PASSWORD?: string;

  @Transform(toInt)
  @IsInt()
  @Min(0)
  REDIS_DB: number = 0;

  // --- Наблюдаемость ---
  @IsEnum(LogLevel)
  LOG_LEVEL: LogLevel = LogLevel.Info;

  // --- HTTP ---
  @Transform(toBoolean)
  @IsBoolean()
  SWAGGER_ENABLED: boolean = true;

  /** Список origin через запятую; пусто — CORS выключен. */
  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  // Пустые строки в .env трактуем как «значение не задано», чтобы работали дефолты класса.
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === '' || value === undefined) continue;
    cleaned[key] = value;
  }

  const validated = plainToInstance(EnvironmentVariables, cleaned, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map((e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('\n');
    throw new Error(`Некорректная конфигурация окружения (.env):\n${details}`);
  }

  return validated;
}
