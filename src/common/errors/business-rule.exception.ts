import { HttpException, HttpStatus } from '@nestjs/common';

import { ErrorCode } from './error-code.enum';

/**
 * Нарушение бизнес-правила → HTTP 422 (ТЗ 3.5).
 * Используется, когда запрос синтаксически корректен, но недопустим по логике
 * предметной области (например, попытка списать коины).
 */
export class BusinessRuleException extends HttpException {
  constructor(message: string, details?: unknown) {
    super(
      { code: ErrorCode.UnprocessableEntity, message, details },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
