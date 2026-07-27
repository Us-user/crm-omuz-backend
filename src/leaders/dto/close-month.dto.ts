import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

import { ISO_MONTH_PATTERN, trimString } from '../../common';
import { DEFAULT_WINNER_PLACES, MAX_WINNER_PLACES } from '../leaders';

const toInt = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

/**
 * Закрытие месяца — фиксация победителей (ТЗ 5.13: «снимок месяца»).
 *
 * Осознанное действие, как «Отправить результат» у недели журнала (ТЗ 5.8):
 * снимок появляется тогда, когда его сняли, а не сам собой.
 */
export class CloseMonthDto {
  @ApiProperty({
    example: '2026-06',
    description:
      'Месяц, который закрывается. Только **завершившийся**: снимок текущего месяца ' +
      'заморозил бы неполные данные (422).',
  })
  @Transform(trimString)
  @IsString()
  @Matches(ISO_MONTH_PATTERN, { message: 'month должен быть месяцем в формате YYYY-MM' })
  month!: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_WINNER_PLACES,
    default: DEFAULT_WINNER_PLACES,
    description:
      'Сколько **мест** фиксировать (ТЗ 5.13: «топ-3»). Отбор идёт по месту, а не ' +
      'по числу строк: при ничьей на последнем месте в снимок попадут все, кто его занял.',
  })
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(MAX_WINNER_PLACES)
  places: number = DEFAULT_WINNER_PLACES;
}
