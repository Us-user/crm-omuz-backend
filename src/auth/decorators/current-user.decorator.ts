import type { ExecutionContext } from '@nestjs/common';
import { createParamDecorator, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth.types';

/**
 * Достаёт пользователя текущего запроса, положенного `JwtAccessStrategy`.
 * Используется только на защищённых эндпоинтах — на `@Public()` его нет.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();

    if (!request.user) {
      throw new UnauthorizedException('Требуется аутентификация');
    }

    return request.user;
  },
);
