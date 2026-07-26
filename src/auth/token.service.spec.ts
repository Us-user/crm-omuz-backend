import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AccountType } from '@prisma/client';

import type { AppConfigService } from '../config';
import type { AccessTokenPayload } from './auth.types';
import { TokenService } from './token.service';

const JWT_CONFIG = {
  accessSecret: 'access-secret-at-least-32-characters-long',
  refreshSecret: 'refresh-secret-at-least-32-characters-long',
  accessTtlSeconds: 3600,
  refreshTtlSeconds: 1_209_600,
};

const PAYLOAD: AccessTokenPayload = {
  sub: '11111111-1111-1111-1111-111111111111',
  sid: '22222222-2222-2222-2222-222222222222',
  type: AccountType.STUDENT,
};

describe('TokenService', () => {
  const jwt = new JwtService({});
  const config = { jwt: JWT_CONFIG } as AppConfigService;
  const service = new TokenService(jwt, config);

  it('выдаёт пару токенов со сроками из конфигурации (ТЗ 3.1: 1 час / 2 недели)', async () => {
    const before = Date.now();
    const pair = await service.issuePair(PAYLOAD);

    expect(pair.expiresIn).toBe(3600);
    expect(pair.refreshExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 1_209_600 * 1000);

    const access = jwt.verify<AccessTokenPayload>(pair.accessToken, {
      secret: JWT_CONFIG.accessSecret,
    });
    expect(access).toMatchObject(PAYLOAD);
  });

  it('делает каждую пару уникальной, даже если выпущена в ту же секунду', async () => {
    // Без `jti` две подписи одной нагрузки совпали бы побайтово (`iat` в секундах),
    // и ротация возвращала бы refresh, неотличимый от предыдущего.
    const [first, second] = await Promise.all([
      service.issuePair(PAYLOAD),
      service.issuePair(PAYLOAD),
    ]);

    expect(first.refreshToken).not.toBe(second.refreshToken);
    expect(first.accessToken).not.toBe(second.accessToken);
    expect(
      service.matchesFingerprint(first.refreshToken, service.fingerprint(second.refreshToken)),
    ).toBe(false);
  });

  it('подписывает access и refresh разными секретами', async () => {
    const pair = await service.issuePair(PAYLOAD);

    expect(() => {
      jwt.verify(pair.refreshToken, { secret: JWT_CONFIG.accessSecret });
    }).toThrow();
    expect(() => {
      jwt.verify(pair.accessToken, { secret: JWT_CONFIG.refreshSecret });
    }).toThrow();
  });

  it('не кладёт в refresh ничего лишнего — только sub и sid', async () => {
    const pair = await service.issuePair(PAYLOAD);
    const payload = await service.verifyRefresh(pair.refreshToken);

    expect(payload.sub).toBe(PAYLOAD.sub);
    expect(payload.sid).toBe(PAYLOAD.sid);
    expect(payload).not.toHaveProperty('type');
  });

  it('отвергает подделанный, испорченный и просроченный refresh', async () => {
    const foreign = jwt.sign(PAYLOAD, { secret: 'чужой-секрет-длиной-более-32-символов' });
    await expect(service.verifyRefresh(foreign)).rejects.toThrow(UnauthorizedException);

    await expect(service.verifyRefresh('не.токен.вовсе')).rejects.toThrow(UnauthorizedException);

    const expired = jwt.sign(PAYLOAD, { secret: JWT_CONFIG.refreshSecret, expiresIn: -10 });
    await expect(service.verifyRefresh(expired)).rejects.toThrow(UnauthorizedException);
  });

  it('отпечаток детерминирован, не содержит самого токена и совпадает только со своим токеном', async () => {
    const pair = await service.issuePair(PAYLOAD);
    const hash = service.fingerprint(pair.refreshToken);

    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(pair.refreshToken);
    expect(service.fingerprint(pair.refreshToken)).toBe(hash);

    expect(service.matchesFingerprint(pair.refreshToken, hash)).toBe(true);
    expect(service.matchesFingerprint(pair.accessToken, hash)).toBe(false);
  });

  it('не падает при сравнении с хешем нестандартной длины', async () => {
    const pair = await service.issuePair(PAYLOAD);

    expect(service.matchesFingerprint(pair.refreshToken, 'коротко')).toBe(false);
    expect(service.matchesFingerprint(pair.refreshToken, '')).toBe(false);
  });
});
