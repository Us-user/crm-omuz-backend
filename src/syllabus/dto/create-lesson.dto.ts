import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus, LessonType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { trimString } from '../../common';

/**
 * Верхняя граница номера дня. Курс длится до 36 месяцев (граница из `courses`),
 * то есть больше года ежедневных занятий — уже опечатка, а не программа.
 */
export const MAX_LESSON_DAY_NUMBER = 366;

/** Больше сотни групп на одном уроке — не мультивыбор, а ошибка запроса. */
export const MAX_LESSON_VISIBLE_GROUPS = 100;

/** Создание урока силлабуса (ТЗ 5.6). */
export class CreateLessonDto {
  @ApiProperty({
    example: 1,
    minimum: 1,
    maximum: MAX_LESSON_DAY_NUMBER,
    description:
      '«Day N» из ТЗ 5.6 — номер учебного дня внутри курса. Не уникален: в один ' +
      'день может стоять и лекция, и практика.',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_LESSON_DAY_NUMBER)
  dayNumber!: number;

  @ApiProperty({ example: 'Вёрстка: блочная модель', minLength: 2, maxLength: 200 })
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ maxLength: 4000, description: 'Пустая строка очищает поле.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional({
    enum: LessonType,
    default: LessonType.LECTURE,
    description: 'Lecture / Practice / Exam (ТЗ 5.6)',
  })
  @IsOptional()
  @IsEnum(LessonType)
  type?: LessonType;

  @ApiPropertyOptional({
    enum: DirectoryStatus,
    default: DirectoryStatus.ACTIVE,
    description: 'INACTIVE — урок остаётся в программе, но выведен из работы',
  })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: MAX_LESSON_VISIBLE_GROUPS,
    description:
      '«Show to group» (ТЗ 5.6) — группы, которым урок открыт. Только группы ' +
      'этого же курса (422). В `PUT` список заменяет набор целиком, пустой массив снимает всех.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LESSON_VISIBLE_GROUPS)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  visibleToGroupIds?: string[];
}
