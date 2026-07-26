import type {
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraintInterface,
} from 'class-validator';
import { ValidatorConstraint, registerDecorator } from 'class-validator';

import { isPermissionCode } from '../permission-catalog';

@ValidatorConstraint({ name: 'isPermissionCode', async: false })
class PermissionCodeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isPermissionCode(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property}: неизвестный код права (ожидается код из каталога, например Permission.Students.Views)`;
  }
}

/**
 * Проверяет, что строка — код из каталога прав (`src/rbac/permission-catalog.ts`).
 *
 * Не `@IsIn(ВСЕ_КОДЫ)`: тот вывалил бы в `details` ошибки все 99 кодов на каждую
 * опечатку. Каталог целиком отдаётся отдельным эндпоинтом `GET /admin/permissions`.
 */
export const IsPermissionCode = (options?: ValidationOptions): PropertyDecorator =>
  function registerIsPermissionCode(target: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isPermissionCode',
      target: target.constructor,
      propertyName: propertyName as string,
      options,
      validator: PermissionCodeConstraint,
    });
  };
