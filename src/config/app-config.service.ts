import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EnvironmentVariables, LogLevel, NodeEnv } from './env.validation';

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

  get redis(): { host: string; port: number; password?: string; db: number } {
    return {
      host: this.get('REDIS_HOST'),
      port: this.get('REDIS_PORT'),
      password: this.get('REDIS_PASSWORD'),
      db: this.get('REDIS_DB'),
    };
  }
}
