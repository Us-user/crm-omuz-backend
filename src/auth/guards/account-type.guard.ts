import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AccountType } from '@prisma/client';

import { ACCOUNT_TYPES_KEY } from '../auth.constants';
import type { AuthenticatedUser } from '../auth.types';

/**
 * Проверяет тип аккаунта, объявленный декоратором `@RequireAccountType(...)`.
 *
 * Тип берётся из access-токена, а не из БД: стратегия намеренно не ходит
 * в базу на каждый запрос. Поэтому операции, меняющие тип аккаунта
 * (перевод Студент → Сотрудник), гасят сессии — иначе токен со старым
 * типом жил бы ещё до часа.
 *
 * Ставится локально (`@UseGuards`), а не глобально: глобальный `JwtAuthGuard`
 * уже наполнил `request.user`, и порядок между двумя глобальными guard'ами
 * не гарантирован.
 */
@Injectable()
export class AccountTypeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AccountType[] | undefined>(
      ACCOUNT_TYPES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!user) {
      throw new UnauthorizedException('Требуется аутентификация');
    }

    if (!required.includes(user.type)) {
      throw new ForbiddenException('Недостаточно прав для выполнения действия');
    }

    return true;
  }
}
