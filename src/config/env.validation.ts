import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsISO31661Alpha2,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

/** Минимальная длина секрета подписи JWT — 256 бит энтропии в hex/base64. */
const MIN_SECRET_LENGTH = 32;

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

  // --- Аутентификация (ТЗ 3.1) ---
  /**
   * Секреты подписи JWT. Разные для access и refresh: даже если утечёт один,
   * подделать токены другого типа нельзя.
   */
  @IsString()
  @MinLength(MIN_SECRET_LENGTH)
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(MIN_SECRET_LENGTH)
  JWT_REFRESH_SECRET!: string;

  /** Время жизни access-токена в секундах. ТЗ: 1 час. */
  @Transform(toInt)
  @IsInt()
  @Min(60)
  JWT_ACCESS_TTL_SECONDS: number = 60 * 60;

  /** Время жизни refresh-токена в секундах. ТЗ: 2 недели. */
  @Transform(toInt)
  @IsInt()
  @Min(60)
  JWT_REFRESH_TTL_SECONDS: number = 14 * 24 * 60 * 60;

  /**
   * Секрет подписи кодов сброса пароля (ТЗ 3.1). Отдельный от JWT: код короткий,
   * и именно этот секрет делает бессмысленным перебор утёкшей таблицы кодов.
   */
  @IsString()
  @MinLength(MIN_SECRET_LENGTH)
  PASSWORD_RESET_SECRET!: string;

  /**
   * Регион по умолчанию для нормализации телефонов в E.164 (ТЗ 3.1):
   * номер без «+» трактуется как номер этого региона. Таджикистан — `TJ`.
   */
  @IsISO31661Alpha2()
  DEFAULT_PHONE_REGION: string = 'TJ';

  // --- Почта (ТЗ 3.4) ---
  /** Адрес отправителя писем: код сброса пароля, приглашения, рассылки. */
  @IsEmail()
  MAIL_FROM: string = 'no-reply@omuz.tj';

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
