import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { AppConfigService } from '../config';
import type { AccessTokenPayload, RefreshTokenPayload, TokenPair } from './auth.types';

/**
 * Выпуск и проверка JWT (ТЗ 3.1: access — 1 час, refresh — 2 недели).
 *
 * Access и refresh подписываются **разными секретами**: access-токен, попавший
 * в логи прокси, нельзя предъявить как refresh.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  async issuePair(payload: AccessTokenPayload): Promise<TokenPair> {
    const { accessSecret, refreshSecret, accessTtlSeconds, refreshTtlSeconds } = this.config.jwt;

    const refreshPayload: RefreshTokenPayload = { sub: payload.sub, sid: payload.sid };

    // `jti` обязателен: без него две подписи одной и той же нагрузки в пределах
    // секунды дают побайтово одинаковый токен (`iat` в секундах), и ротация
    // возвращала бы «новый» refresh, неотличимый от старого.
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: accessSecret,
        expiresIn: accessTtlSeconds,
        jwtid: randomUUID(),
      }),
      this.jwt.signAsync(refreshPayload, {
        secret: refreshSecret,
        expiresIn: refreshTtlSeconds,
        jwtid: randomUUID(),
      }),
    ]);

    return {
      accessToken,
      refreshToken,
      expiresIn: accessTtlSeconds,
      refreshExpiresAt: new Date(Date.now() + refreshTtlSeconds * 1000),
    };
  }

  /**
   * Проверяет подпись и срок refresh-токена.
   *
   * @throws UnauthorizedException если токен подделан, испорчен или просрочен.
   */
  async verifyRefresh(token: string): Promise<RefreshTokenPayload> {
    try {
      const payload = await this.jwt.verifyAsync<RefreshTokenPayload>(token, {
        secret: this.config.jwt.refreshSecret,
      });

      if (!payload.sub || !payload.sid) {
        throw new Error('в токене нет sub/sid');
      }

      return payload;
    } catch {
      throw new UnauthorizedException('Refresh-токен недействителен или истёк');
    }
  }

  /**
   * Отпечаток токена для хранения в БД. Сам refresh не сохраняется: утечка дампа
   * не даёт возможности войти. SHA-256 достаточно — токен и так высокоэнтропийный,
   * а детерминированный хеш позволяет сравнивать без перебора солей.
   */
  fingerprint(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Сравнение отпечатков за постоянное время: обычное `===` выходит на первом
   * несовпавшем символе, и по времени ответа хеш можно подобрать посимвольно.
   */
  matchesFingerprint(token: string, storedHash: string): boolean {
    const actual = Buffer.from(this.fingerprint(token), 'hex');
    const expected = Buffer.from(storedHash, 'hex');

    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }
}
