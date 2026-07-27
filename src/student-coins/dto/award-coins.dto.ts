import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

import { trimString } from '../../common';

/** Потолок ручного начисления — защита от лишнего нуля, а не правило ТЗ. */
export const MAX_MANUAL_COINS = 1000;

/**
 * Ручное начисление коинов (ТЗ 5.9: «учителя/сотрудники, обязательная причина;
 * списание запрещено»).
 */
export class AwardCoinsDto {
  @ApiProperty({
    minimum: 1,
    maximum: MAX_MANUAL_COINS,
    example: 3,
    description:
      'Сколько коинов начислить. Только положительное: списание коинов ' +
      'запрещено (ТЗ 5.9), поэтому ноль и отрицательные значения — 400.',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_MANUAL_COINS)
  amount!: number;

  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    example: 'Помог однокурсникам с проектом',
    description: 'Причина начисления — обязательна (ТЗ 5.9).',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
