import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EnvironmentVariables, LogLevel, NodeEnv } from './env.validation';
import type { RedisConnectionOptions } from './redis-url';
import { parseRedisUrl } from './redis-url';

/**
 * Типобезопасная обёртка над `ConfigService`: остальной код не обращается
 * к `process.env` напрямую и не занимается приведением типов.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

  private get<K extends keyof EnvironmentVariables>(key: K): EnvironmentVariables[K] {
    return this.config.get(key, { infer: true });
  }

  get nodeEnv(): NodeEnv {
    return this.get('NODE_ENV');
  }

  get isProduction(): boolean {
    return this.nodeEnv === NodeEnv.Production;
  }

  get isTest(): boolean {
    return this.nodeEnv === NodeEnv.Test;
  }

  get port(): number {
    return this.get('PORT');
  }

  get databaseUrl(): string {
    return this.get('DATABASE_URL');
  }

  get logLevel(): LogLevel {
    return this.get('LOG_LEVEL');
  }

  get jwt(): {
    accessSecret: string;
    refreshSecret: string;
    accessTtlSeconds: number;
    refreshTtlSeconds: number;
  } {
    return {
      accessSecret: this.get('JWT_ACCESS_SECRET'),
      refreshSecret: this.get('JWT_REFRESH_SECRET'),
      accessTtlSeconds: this.get('JWT_ACCESS_TTL_SECONDS'),
      refreshTtlSeconds: this.get('JWT_REFRESH_TTL_SECONDS'),
    };
  }

  /** Секрет подписи одноразовых кодов сброса пароля (ТЗ 3.1). */
  get passwordResetSecret(): string {
    return this.get('PASSWORD_RESET_SECRET');
  }

  /** Регион по умолчанию для нормализации телефонов в E.164. */
  get defaultPhoneRegion(): string {
    return this.get('DEFAULT_PHONE_REGION');
  }

  /** Адрес отправителя писем (ТЗ 3.4). */
  get mailFrom(): string {
    return this.get('MAIL_FROM');
  }

  /** Смещение часового пояса центра от UTC в минутах (ТЗ 3.3). Таджикистан — 300. */
  get centerUtcOffsetMinutes(): number {
    return this.get('CENTER_UTC_OFFSET_MINUTES');
  }

  /** Включены ли фоновые задачи по расписанию (ТЗ 3.4). В тестах — всегда выключены. */
  get scheduledTasksEnabled(): boolean {
    return this.get('SCHEDULED_TASKS_ENABLED');
  }

  /** Включено ли ограничение частоты запросов на auth и сброс пароля (ТЗ 3.8). */
  get rateLimitEnabled(): boolean {
    return this.get('RATE_LIMIT_ENABLED');
  }

  /**
   * Значение express `trust proxy` в том виде, в каком его принимает express:
   * `true`/`false`, число хопов или список адресов. `undefined` означает
   * «не задано» — настройку express не трогаем и остаёмся на его умолчании.
   */
  get trustProxy(): boolean | number | string | undefined {
    const raw = this.get('TRUST_PROXY')?.trim();
    if (!raw) return undefined;

    const lowered = raw.toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;

    // Число хопов: `TRUST_PROXY=1` — доверять ровно ближайшему прокси.
    const hops = Number(raw);
    if (Number.isInteger(hops) && hops >= 0) return hops;

    // Всё прочее — список адресов и подсетей; express разбирает его сам.
    return raw;
  }

  get swaggerEnabled(): boolean {
    return this.get('SWAGGER_ENABLED');
  }

  get corsOrigins(): string[] {
    const raw = this.get('CORS_ORIGINS');
    if (!raw) return [];
    return raw
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  /**
   * Подключение к Redis. `REDIS_URL` **перекрывает** поля по отдельности:
   * облачные провайдеры выдают строку, и держать рядом второй, частично
   * заполненный набор значило бы иметь два источника истины об одном адресе.
   */
  get redis(): RedisConnectionOptions {
    const url = this.get('REDIS_URL')?.trim();
    if (url) return parseRedisUrl(url);

    return {
      host: this.get('REDIS_HOST'),
      port: this.get('REDIS_PORT'),
      password: this.get('REDIS_PASSWORD'),
      db: this.get('REDIS_DB'),
      tls: false,
    };
  }

  /**
   * Данные первого руководителя (решение сессии 0007) или `null`, если
   * заведение при старте не настроено.
   *
   * Все четыре поля обязательны вместе: наполовину заполненный набор — это
   * почти наверняка забытая переменная, и молча пропустить его значило бы
   * оставить площадку без единого способа войти. Об этом предупреждает
   * `AdminSeedBootstrap`.
   */
  get seedAdmin(): SeedAdminEnv | null {
    const phone = this.get('SEED_ADMIN_PHONE');
    const email = this.get('SEED_ADMIN_EMAIL');
    const firstName = this.get('SEED_ADMIN_FIRST_NAME');
    const lastName = this.get('SEED_ADMIN_LAST_NAME');

    if (!phone || !email || !firstName || !lastName) return null;

    return {
      phone,
      email,
      firstName,
      lastName,
      middleName: this.get('SEED_ADMIN_MIDDLE_NAME'),
      password: this.get('SEED_ADMIN_PASSWORD'),
    };
  }

  /** Задана ли хотя бы одна переменная `SEED_ADMIN_*` — чтобы отличить «не настроено» от «настроено наполовину». */
  get seedAdminPartiallyConfigured(): boolean {
    return (
      [
        this.get('SEED_ADMIN_PHONE'),
        this.get('SEED_ADMIN_EMAIL'),
        this.get('SEED_ADMIN_FIRST_NAME'),
        this.get('SEED_ADMIN_LAST_NAME'),
      ].some(Boolean) && this.seedAdmin === null
    );
  }
}

/** Данные первого руководителя из окружения. */
export interface SeedAdminEnv {
  phone: string;
  email: string;
  firstName: string;
  lastName: string;
  middleName?: string;
  password?: string;
}
