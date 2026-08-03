import { SetMetadata } from '@nestjs/common';

export const AUDIT_ACTION_KEY = 'audit:action';

/**
 * Явное имя действия для журнала (ТЗ 3.6).
 *
 * Обычно имя берётся из права каталога (`Permission.Students.Create` →
 * `Students.Create`), и декоратор не нужен. Он нужен там, где права каталога
 * нет по устройству раздела: вход и регистрация (токена ещё нет) и кабинет
 * ментора, где разрешением служит менторство, а не право (0023).
 *
 * @example
 * ```ts
 * @AuditAction('Auth.Login')
 * login() {}
 * ```
 */
export const AuditAction = (action: string): MethodDecorator & ClassDecorator =>
  SetMetadata(AUDIT_ACTION_KEY, action);
