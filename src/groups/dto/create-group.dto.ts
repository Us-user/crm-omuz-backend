import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DurationUnit, GroupFormat, GroupStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { trimString } from '../../common';

/**
 * Дата в `YYYY-MM-DD` **или пустая строка**. Пустая строка — то же «очистить
 * поле», что и у текстовых полей формы (см. `emptyToNull`): без неё сроки,
 * заданные по ошибке, нельзя было бы снять через `PUT`.
 */
const ISO_DATE_OR_EMPTY = /^$|^\d{4}-\d{2}-\d{2}$/;

/**
 * Верхняя граница длительности — та же, что у курса: три года в месяцах
 * это уже опечатка. Константа своя, а не импортированная из `courses`:
 * граница здесь про группу, и модули не должны тянуть друг друга ради числа.
 */
export const MAX_GROUP_DURATION_VALUE = 36;

/** Больше сотни человек в группе учебного центра — тоже опечатка. */
export const MAX_GROUP_CAPACITY = 100;

/** Создание учебной группы (ТЗ 5.5). */
export class CreateGroupDto {
  @ApiProperty({
    example: 'Frontend-1',
    minLength: 1,
    maxLength: 120,
    description: 'Название группы. Уникально внутри филиала, без учёта регистра.',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ maxLength: 2000, description: 'Описание. Пустая строка очищает поле.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ format: 'uuid', description: 'Курс, по которому учится группа (ТЗ 5.6)' })
  @IsUUID()
  courseId!: string;

  @ApiProperty({ format: 'uuid', description: 'Филиал группы (ТЗ 3.3, фильтр «Branch» из ТЗ 5.5)' })
  @IsUUID()
  branchId!: string;

  @ApiPropertyOptional({ enum: GroupFormat, default: GroupFormat.OFFLINE })
  @IsOptional()
  @IsEnum(GroupFormat)
  format?: GroupFormat;

  @ApiPropertyOptional({ example: '2026-09-01', description: 'Дата начала занятий, `YYYY-MM-DD`' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(ISO_DATE_OR_EMPTY, { message: 'startDate должен быть датой в формате YYYY-MM-DD' })
  startDate?: string;

  @ApiPropertyOptional({
    example: '2026-09-30',
    description: 'Дата окончания, `YYYY-MM-DD`. Не может быть раньше даты начала.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(ISO_DATE_OR_EMPTY, { message: 'endDate должен быть датой в формате YYYY-MM-DD' })
  endDate?: string;

  @ApiPropertyOptional({
    example: 1,
    minimum: 1,
    maximum: MAX_GROUP_DURATION_VALUE,
    description:
      'Длительность обучения числом (ТЗ 5.5). Может отличаться от длительности курса. ' +
      'Задаётся только вместе с `durationUnit`.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_GROUP_DURATION_VALUE)
  durationValue?: number;

  @ApiPropertyOptional({ enum: DurationUnit, default: DurationUnit.MONTH })
  @IsOptional()
  @IsEnum(DurationUnit)
  durationUnit?: DurationUnit;

  @ApiPropertyOptional({
    example: 16,
    minimum: 1,
    maximum: MAX_GROUP_CAPACITY,
    description: '«Required students» из ТЗ 5.5 — сколько человек набирают в группу',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_GROUP_CAPACITY)
  capacity?: number;

  @ApiPropertyOptional({ enum: GroupStatus, default: GroupStatus.RECRUITING })
  @IsOptional()
  @IsEnum(GroupStatus)
  status?: GroupStatus;

  @ApiPropertyOptional({
    example: 'https://t.me/omuz_frontend_1',
    maxLength: 300,
    description: 'Ссылка на групповой чат (ТЗ 5.5). Пустая строка очищает поле.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(300)
  telegramUrl?: string;
}
