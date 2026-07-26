import type { ExecutionContext } from '@nestjs/common';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { IS_PUBLIC_KEY, JWT_ACCESS_STRATEGY } from '../auth.constants';

/**
 * Глобальный guard аутентификации: закрыто всё, кроме помеченного `@Public()`.
 * Такой порядок означает, что новый эндпоинт по умолчанию защищён (ТЗ 3.8).
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard(JWT_ACCESS_STRATEGY) {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    return super.canActivate(context);
  }

  override handleRequest<TUser>(err: unknown, user: TUser): TUser {
    if (err || !user) {
      // Единая формулировка: не различаем «нет заголовка», «подпись не сошлась»
      // и «токен просрочен» — деталь помогла бы только подбору.
      throw err instanceof Error ? err : new UnauthorizedException('Требуется аутентификация');
    }

    return user;
  }
}
