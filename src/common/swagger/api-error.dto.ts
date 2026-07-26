import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ErrorCode } from '../errors/error-code.enum';

class ApiErrorBodyDto {
  @ApiProperty({ enum: ErrorCode, example: ErrorCode.ValidationError })
  code!: string;

  @ApiProperty({ example: 'Ошибка валидации входных данных' })
  message!: string;

  @ApiPropertyOptional({
    description: 'Детали ошибки: список нарушений валидации, поле-конфликт и т.п.',
    example: ['phone must be a valid phone number'],
  })
  details?: unknown;

  @ApiPropertyOptional({ description: 'Идентификатор запроса для поиска в логах' })
  requestId?: string;

  @ApiProperty({ example: '2026-07-26T10:15:00.000Z' })
  timestamp!: string;
}

/** Тело ответа с ошибкой (ТЗ 3.5). */
export class ApiErrorDto {
  @ApiProperty({ type: ApiErrorBodyDto })
  error!: ApiErrorBodyDto;
}
