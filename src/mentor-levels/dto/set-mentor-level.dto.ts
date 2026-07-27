import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, IsUUID, Matches } from 'class-validator';

import { ISO_MONTH_PATTERN, trimString } from '../../common';

/**
 * Простановка уровня сотрудника на месяц (ТЗ 5.14: `PUT /employees/{id}/mentor-levels`).
 *
 * Запрос идемпотентен: на сотрудника в месяце ровно одна запись (решение
 * пользователя, сессия 0021), поэтому повторный `PUT` с другой ступенью
 * меняет её, а не заводит вторую строку.
 */
export class SetMentorLevelDto {
  @ApiProperty({
    example: '2026-09',
    pattern: ISO_MONTH_PATTERN.source,
    description:
      'Месяц в формате `YYYY-MM`. По ставке уровня **этого** месяца считается ' +
      'зарплата за него (ТЗ 5.16).',
  })
  @Transform(trimString)
  @IsString()
  @Matches(ISO_MONTH_PATTERN, { message: 'month должен быть месяцем в формате YYYY-MM' })
  month!: string;

  @ApiProperty({ format: 'uuid', description: 'Ступень из справочника `/mentor-levels`' })
  @IsUUID()
  levelId!: string;
}
