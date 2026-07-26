import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccountType } from '@prisma/client';

import type { AuthenticatedUser } from '../auth.types';
import { AccountTypeGuard } from './account-type.guard';

const user = (type: AccountType): AuthenticatedUser => ({
  accountId: '11111111-1111-1111-1111-111111111111',
  sessionId: '22222222-2222-2222-2222-222222222222',
  type,
});

/** Контекст запроса с готовым `request.user` — его наполняет глобальный `JwtAuthGuard`. */
const context = (current?: AuthenticatedUser): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user: current }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  }) as unknown as ExecutionContext;

describe('AccountTypeGuard', () => {
  let reflector: Reflector;
  let guard: AccountTypeGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new AccountTypeGuard(reflector);
  });

  const requireTypes = (types: AccountType[] | undefined): void => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(types);
  };

  it('пропускает эндпоинт без требований к типу аккаунта', () => {
    requireTypes(undefined);

    expect(guard.canActivate(context(user(AccountType.STUDENT)))).toBe(true);
  });

  it('пропускает аккаунт разрешённого типа', () => {
    requireTypes([AccountType.EMPLOYEE]);

    expect(guard.canActivate(context(user(AccountType.EMPLOYEE)))).toBe(true);
  });

  it('отклоняет аккаунт чужого типа (403)', () => {
    requireTypes([AccountType.EMPLOYEE]);

    expect(() => guard.canActivate(context(user(AccountType.STUDENT)))).toThrow(ForbiddenException);
  });

  it('отклоняет запрос без пользователя (401): guard не должен становиться дырой', () => {
    requireTypes([AccountType.EMPLOYEE]);

    expect(() => guard.canActivate(context())).toThrow(UnauthorizedException);
  });

  it('пустой список типов не запрещает всё подряд', () => {
    requireTypes([]);

    expect(guard.canActivate(context(user(AccountType.STUDENT)))).toBe(true);
  });
});
