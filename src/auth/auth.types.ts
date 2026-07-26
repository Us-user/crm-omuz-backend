import type { AccountType } from '@prisma/client';

/** Полезная нагрузка access-токена. */
export interface AccessTokenPayload {
  /** Идентификатор аккаунта. */
  sub: string;
  /** Идентификатор серверной сессии — по нему работает `logout`. */
  sid: string;
  /** Тип профиля: студенту доступен только просмотр своих данных (ТЗ 3.2). */
  type: AccountType;
}

/** Полезная нагрузка refresh-токена: только то, что нужно для поиска сессии. */
export interface RefreshTokenPayload {
  sub: string;
  sid: string;
}

/**
 * Пользователь текущего запроса. Кладётся в `request.user` стратегией
 * и достаётся декоратором `@CurrentUser()`.
 */
export interface AuthenticatedUser {
  accountId: string;
  sessionId: string;
  type: AccountType;
}

/** Данные вызывающего клиента — сохраняются в сессии для списка устройств. */
export interface RequestContext {
  userAgent?: string;
  ip?: string;
}

/** Пара токенов, выдаваемая при входе, регистрации и обновлении. */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Время жизни access-токена в секундах. */
  expiresIn: number;
  /** Момент истечения refresh-токена — записывается в сессию. */
  refreshExpiresAt: Date;
}
