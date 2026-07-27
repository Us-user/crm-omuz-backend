import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LessonType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  Matches,
  ValidateNested,
} from 'class-validator';

import { ISO_DATE_PATTERN } from '../../common';

/** Сколько учебных дней помещается в неделю — ровно семь суток. */
export const MAX_DAYS_PER_WEEK = 7;

/** Учебный день недели (ТЗ 5.8: «по дням»). */
export class JournalDayInputDto {
  @ApiProperty({ example: '2026-09-07', description: 'Дата занятия, `YYYY-MM-DD`' })
  @Matches(ISO_DATE_PATTERN, { message: 'date: ожидается дата в формате YYYY-MM-DD' })
  date!: string;

  @ApiPropertyOptional({
    enum: LessonType,
    default: LessonType.LECTURE,
    description:
      'Тип занятия (ТЗ 5.6). На `EXAM` приход не начисляется (ТЗ 5.8): балл ' +
      'за экзамен идёт отдельным слагаемым `exam` в итоге недели.',
  })
  @IsOptional()
  @IsEnum(LessonType)
  type?: LessonType;
}

/**
 * Новая неделя журнала (ТЗ 5.8: «NEW WEEK»).
 *
 * Номер недели не передаётся: его назначает система (`max + 1` по группе).
 * Два способа задать один и тот же порядок разошлись бы на первой же попытке
 * вставить неделю в середину.
 */
export class CreateJournalWeekDto {
  @ApiProperty({
    example: '2026-09-07',
    description:
      'Начало недели, `YYYY-MM-DD`. Все учебные дни обязаны укладываться ' +
      'в семь суток от этой даты.',
  })
  @Matches(ISO_DATE_PATTERN, { message: 'startDate: ожидается дата в формате YYYY-MM-DD' })
  startDate!: string;

  @ApiProperty({
    type: [JournalDayInputDto],
    description: 'Учебные дни недели: от одного до семи, даты не повторяются.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_DAYS_PER_WEEK)
  @ValidateNested({ each: true })
  @Type(() => JournalDayInputDto)
  days!: JournalDayInputDto[];
}
