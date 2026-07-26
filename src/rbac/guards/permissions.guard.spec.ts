import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccountType } from '@prisma/client';

import type { AuthenticatedUser } from '../../auth';
import type { PermissionCode } from '../permission-catalog';
import type { PermissionsService } from '../permissions.service';
import { PermissionsGuard } from './permissions.guard';

const user = (type: AccountType): AuthenticatedUser => ({
  accountId: '11111111-1111-1111-1111-111111111111',
  sessionId: '22222222-2222-2222-2222-222222222222',
  type,
});

const context = (current?: AuthenticatedUser): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user: current }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  }) as unknown as ExecutionContext;

describe('PermissionsGuard', () => {
  let reflector: Reflector;
  let permissions: jest.Mocked<Pick<PermissionsService, 'hasPermissions'>>;
  let guard: PermissionsGuard;

  beforeEach(() => {
    reflector = new Reflector();
    permissions = { hasPermissions: jest.fn() };
    guard = new PermissionsGuard(reflector, permissions as unknown as PermissionsService);
  });

  const require = (codes: PermissionCode[] | undefined): void => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(codes);
  };

  it('пропускает эндпоинт без объявленных прав', async () => {
    require(undefined);

    await expect(guard.canActivate(context(user(AccountType.EMPLOYEE)))).resolves.toBe(true);
    expect(permissions.hasPermissions).not.toHaveBeenCalled();
  });

  it('пропускает сотрудника, у которого право есть', async () => {
    require(['Permission.Students.Promote']);
    permissions.hasPermissions.mockResolvedValue(true);

    await expect(guard.canActivate(context(user(AccountType.EMPLOYEE)))).resolves.toBe(true);
    expect(permissions.hasPermissions).toHaveBeenCalledWith(user(AccountType.EMPLOYEE).accountId, [
      'Permission.Students.Promote',
    ]);
  });

  it('отклоняет сотрудника без права (403)', async () => {
    require(['Permission.Students.Promote']);
    permissions.hasPermissions.mockResolvedValue(false);

    await expect(guard.canActivate(context(user(AccountType.EMPLOYEE)))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('отклоняет студента, не заглядывая в БД: права выдаются только позициями (ТЗ 3.2)', async () => {
    require(['Permission.Students.Promote']);

    await expect(guard.canActivate(context(user(AccountType.STUDENT)))).rejects.toThrow(
      ForbiddenException,
    );
    expect(permissions.hasPermissions).not.toHaveBeenCalled();
  });

  it('отклоняет запрос без пользователя (401): guard не должен становиться дырой', async () => {
    require(['Permission.Students.Promote']);

    await expect(guard.canActivate(context())).rejects.toThrow(UnauthorizedException);
  });

  it('пустой список прав не запрещает всё подряд', async () => {
    require([]);

    await expect(guard.canActivate(context(user(AccountType.STUDENT)))).resolves.toBe(true);
  });

  it('не раскрывает, какого именно права не хватает', async () => {
    require(['Permission.Accounting.Views']);
    permissions.hasPermissions.mockResolvedValue(false);

    await expect(guard.canActivate(context(user(AccountType.EMPLOYEE)))).rejects.toThrow(
      'Недостаточно прав для выполнения действия',
    );
  });
});
