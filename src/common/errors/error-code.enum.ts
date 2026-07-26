import { HttpStatus } from '@nestjs/common';

/** Машиночитаемые коды ошибок API (ТЗ 3.5). */
export enum ErrorCode {
  ValidationError = 'VALIDATION_ERROR',
  Unauthorized = 'UNAUTHORIZED',
  Forbidden = 'FORBIDDEN',
  NotFound = 'NOT_FOUND',
  Conflict = 'CONFLICT',
  UnprocessableEntity = 'UNPROCESSABLE_ENTITY',
  TooManyRequests = 'TOO_MANY_REQUESTS',
  InternalError = 'INTERNAL_ERROR',
}

const STATUS_TO_CODE: ReadonlyMap<number, ErrorCode> = new Map([
  [HttpStatus.BAD_REQUEST, ErrorCode.ValidationError],
  [HttpStatus.UNAUTHORIZED, ErrorCode.Unauthorized],
  [HttpStatus.FORBIDDEN, ErrorCode.Forbidden],
  [HttpStatus.NOT_FOUND, ErrorCode.NotFound],
  [HttpStatus.CONFLICT, ErrorCode.Conflict],
  [HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.UnprocessableEntity],
  [HttpStatus.TOO_MANY_REQUESTS, ErrorCode.TooManyRequests],
]);

export function errorCodeForStatus(status: number): ErrorCode {
  return STATUS_TO_CODE.get(status) ?? ErrorCode.InternalError;
}
