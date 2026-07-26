import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { AppConfigService } from '../../config';
import { JWT_ACCESS_STRATEGY } from '../auth.constants';
import type { AccessTokenPayload, AuthenticatedUser } from '../auth.types';

/**
 * Разбор `Authorization: Bearer <access>` (ТЗ 3.5).
 *
 * Обращения к БД здесь нет: access живёт всего час, и поход в базу на каждый
 * запрос свёл бы на нет смысл stateless-токена. Немедленный отзыв доступа
 * обеспечивается коротким TTL и гашением сессии — обновиться уже не выйдет.
 */
@Injectable()
export class JwtAccessStrategy extends PassportStrategy(Strategy, JWT_ACCESS_STRATEGY) {
  constructor(config: AppConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.jwt.accessSecret,
    });
  }

  validate(payload: AccessTokenPayload): AuthenticatedUser {
    return {
      accountId: payload.sub,
      sessionId: payload.sid,
      type: payload.type,
    };
  }
}
