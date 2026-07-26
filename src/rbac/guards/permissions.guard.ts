import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccountType } from '@prisma/client';

import type { AuthenticatedUser } from '../../auth';
import type { PermissionCode } from '../permission-catalog';
import { PermissionsService } from '../permissions.service';
import { PERMISSIONS_KEY } from '../rbac.constants';

/**
 * Проверяет права, объявленные декоратором `@RequirePermission(...)` (ТЗ 3.2, 3.8).
 *
 * Ставится не глобально, а самим декоратором (`applyDecorators`): порядок
 * между двумя глобальными guard'ами не гарантирован, а этот обязан работать
 * после `JwtAuthGuard`, который наполняет `request.user`.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionCode[] | undefined>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!user) {
      throw new UnauthorizedException('Требуется аутентификация');
    }

    // Права выдаются позициями, а позиции есть только у сотрудников (ТЗ 3.2):
    // студенту отказываем сразу, не тратя запрос в БД.
    if (user.type !== AccountType.EMPLOYEE) {
      throw new ForbiddenException('Недостаточно прав для выполнения действия');
    }

    const allowed = await this.permissions.hasPermissions(user.accountId, required);
    if (!allowed) {
      throw new ForbiddenException('Недостаточно прав для выполнения действия');
    }

    return true;
  }
}
