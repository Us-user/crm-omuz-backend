import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { trimString } from '../../common';

/**
 * Верхняя граница часовой ставки. Колонка — `DECIMAL(12,2)`, и без ограничения
 * сверху число, не влезающее в неё, дошло бы до БД и вернулось ошибкой 500
 * (то же, что со стоимостью курса в сессии 0007).
 */
export const MAX_HOURLY_RATE = 9_999_999_999.99;

/** Создание ступени справочника уровней ментора (ТЗ 5.14). */
export class CreateMentorLevelDto {
  @ApiProperty({
    example: 'Senior mentor',
    minLength: 2,
    maxLength: 120,
    description: 'Название ступени. Уникально без учёта регистра.',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    maxLength: 1000,
    description: 'Пустая строка очищает поле.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({
    example: 45,
    minimum: 0,
    maximum: MAX_HOURLY_RATE,
    description:
      'Часовая ставка в сомони (TJS). Из неё в Фазе 9 считается зарплата ' +
      '«часы × ставка уровня месяца» (ТЗ 5.16).',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_HOURLY_RATE)
  hourlyRate!: number;

  @ApiPropertyOptional({
    enum: DirectoryStatus,
    default: DirectoryStatus.ACTIVE,
    description:
      'Выведенную ступень (`INACTIVE`) новым месяцам не проставляют, но уже ' +
      'проставленная остаётся: иначе прошлые зарплаты потеряли бы ставку.',
  })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;
}
