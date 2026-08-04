import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsISO31661Alpha2,
  IsOptional,
  IsString,
  Matches,
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
  /**
   * Строка подключения целиком. Облачные провайдеры (Render Key Value, Upstash,
   * Redis Cloud) выдают именно её, а не набор полей. **Задана — перекрывает**
   * `REDIS_HOST`/`PORT`/`PASSWORD`/`DB`: два источника истины об одном
   * подключении разошлись бы при первой же правке.
   */
  @IsOptional()
  @Matches(/^rediss?:\/\//, {
    message: 'REDIS_URL должен начинаться с redis:// или rediss://',
  })
  REDIS_URL?: string;

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

  // --- Часовой пояс центра и фоновые задачи (ТЗ 3.3, 3.4) ---
  /**
   * Смещение часового пояса центра от UTC в минутах. Таджикистан — UTC+5, то есть
   * 300. Весь проект хранит время в UTC, но день рождения — понятие местного дня
   * (решение пользователя): именинников дня отбирают по календарю центра, а не
   * по UTC, иначе часть людей поздравляли бы днём раньше или позже.
   */
  @Transform(toInt)
  @IsInt()
  @Min(-720)
  @Max(840)
  CENTER_UTC_OFFSET_MINUTES: number = 300;

  /**
   * Включены ли фоновые задачи по расписанию (поздравления с ДР, уборка зависших
   * доставок, автозакрытие месяца рейтинга). Выключатель нужен, чтобы поднять
   * приложение без планировщика — например, второй экземпляр, который только
   * обслуживает HTTP. В тестовом окружении планировщик не регистрируется в любом
   * случае: повторяющиеся задачи живут в Redis, а наборам он не нужен.
   */
  @Transform(toBoolean)
  @IsBoolean()
  SCHEDULED_TASKS_ENABLED: boolean = true;

  // --- Ограничение частоты запросов (ТЗ 3.8) ---
  /**
   * Включено ли ограничение частоты запросов на аутентификацию и сброс пароля.
   * Выключатель нужен нагрузочным прогонам и локальной отладке; в проде его
   * трогать незачем. Недоступный Redis лимит **не** выключает — он пропускает
   * запросы сам (fail-open, см. `RateLimitService`).
   */
  @Transform(toBoolean)
  @IsBoolean()
  RATE_LIMIT_ENABLED: boolean = true;

  // --- Первый руководитель (ТЗ 3.2, решение сессии 0007) ---
  /**
   * Заведение первого `Director` при старте приложения.
   *
   * Зачем это существует: система закрыта сама на себя — регистрация создаёт
   * только студентов, а раздача ролей требует прав, которых на пустой базе
   * нет ни у кого. Для этого есть `npm run seed:admin`, но **на площадках без
   * доступа к shell** (бесплатный план Render, например) запустить его нечем,
   * и CRM осталась бы недоступной вообще никому.
   *
   * Заполнены все четыре обязательных — при старте заводится руководитель.
   * Операция идемпотентна: существующий аккаунт не трогается и пароль
   * не меняется. После первого входа переменные можно убрать.
   */
  @IsOptional()
  @IsString()
  @MinLength(5)
  SEED_ADMIN_PHONE?: string;

  @IsOptional()
  @IsEmail()
  SEED_ADMIN_EMAIL?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  SEED_ADMIN_FIRST_NAME?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  SEED_ADMIN_LAST_NAME?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  SEED_ADMIN_MIDDLE_NAME?: string;

  /**
   * Пароль первого руководителя. Проверяется здесь же, чтобы опечатка
   * обнаружилась при старте, а не молчаливым «руководитель не завёлся»
   * в середине лога (ТЗ 3.8: приложение не поднимается на плохой конфигурации).
   */
  @IsOptional()
  @IsString()
  @MinLength(8)
  SEED_ADMIN_PASSWORD?: string;

  // --- Наблюдаемость ---
  @IsEnum(LogLevel)
  LOG_LEVEL: LogLevel = LogLevel.Info;

  // --- HTTP ---
  /**
   * Значение express `trust proxy`. **Обязательно на проде**, где приложение
   * стоит за обратным прокси с HTTPS (ТЗ 3.8): без него `request.ip` — адрес
   * прокси, то есть один на всех, и лимит по адресу закрыл бы вход всему
   * центру разом, а в логах и сессиях стоял бы адрес балансировщика.
   *
   * Понимаются четыре формы: `true` (доверять ближайшему прокси целиком),
   * `false`/пусто (не доверять), число (сколько хопов пропустить) и список
   * адресов/подсетей через запятую (`loopback`, `10.0.0.0/8`, …).
   */
  @IsOptional()
  @IsString()
  TRUST_PROXY?: string;

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
