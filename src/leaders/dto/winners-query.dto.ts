import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches } from 'class-validator';

import { ISO_MONTH_PATTERN, trimString } from '../../common';

/**
 * Победители месяца (ТЗ 5.13: `GET /leaders/winners?month=…`).
 *
 * Месяц **необязателен**: без него отдаётся последний закрытый — ровно то,
 * что ТЗ называет «Winners of the last month». «Последний» здесь означает
 * последний **из снятых снимков**, а не прошлый календарный: месяц, который
 * никто не закрыл, победителей не имеет, и подставлять вместо него расчёт
 * на лету значило бы выдать за снимок то, что снимком не является.
 */
export class WinnersQueryDto {
  @ApiPropertyOptional({
    example: '2026-06',
    description: 'Месяц снимка. Без него — последний закрытый месяц.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(ISO_MONTH_PATTERN, { message: 'month должен быть месяцем в формате YYYY-MM' })
  month?: string;
}
