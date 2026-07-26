import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus, DurationUnit } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { trimString } from '../../common';

/**
 * Верхняя граница стоимости. Колонка — `DECIMAL(12,2)`, и без ограничения
 * сверху число, не влезающее в неё, дошло бы до БД и вернулось ошибкой 500.
 */
export const MAX_COURSE_FEE = 9_999_999_999.99;

/** Максимальная длительность в любых единицах: три года месяцами — уже опечатка. */
export const MAX_DURATION_VALUE = 36;

/** Цвет карточки курса в формате `#RRGGBB` (Color1/Color2 из ТЗ 5.6). */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Создание курса (ТЗ 5.6). */
export class CreateCourseDto {
  @ApiProperty({
    example: 'Frontend Basic',
    minLength: 2,
    maxLength: 120,
    description: 'Название курса. Уникально без учёта регистра.',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  title!: string;

  @ApiPropertyOptional({ example: 'HTML, CSS и вёрстка', maxLength: 200 })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  subtitle?: string;

  @ApiPropertyOptional({ maxLength: 2000, description: 'Пустая строка очищает поле.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({
    example: 1200,
    minimum: 0,
    maximum: MAX_COURSE_FEE,
    description:
      'Стоимость курса в сомони (TJS). Курс длится около месяца, поэтому это же ' +
      'значение становится помесячным начислением в бухгалтерии (ТЗ 5.16).',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_COURSE_FEE)
  fee!: number;

  @ApiPropertyOptional({
    default: false,
    description:
      '«Is last course» (ТЗ 5.6): завершение группы такого курса запускает автовыпуск (ТЗ 5.11).',
  })
  @IsOptional()
  @IsBoolean()
  isLastCourse?: boolean;

  @ApiPropertyOptional({ example: '#1E88E5', description: 'Color1, формат #RRGGBB' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(HEX_COLOR, { message: 'colorPrimary должен быть цветом в формате #RRGGBB' })
  colorPrimary?: string;

  @ApiPropertyOptional({ example: '#0D47A1', description: 'Color2, формат #RRGGBB' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(HEX_COLOR, { message: 'colorSecondary должен быть цветом в формате #RRGGBB' })
  colorSecondary?: string;

  @ApiPropertyOptional({ example: 'https://cdn.omuz.tj/courses/frontend.png', maxLength: 500 })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  logoUrl?: string;

  @ApiProperty({ example: 1, minimum: 1, maximum: MAX_DURATION_VALUE })
  @IsInt()
  @Min(1)
  @Max(MAX_DURATION_VALUE)
  durationValue!: number;

  @ApiPropertyOptional({ enum: DurationUnit, default: DurationUnit.MONTH })
  @IsOptional()
  @IsEnum(DurationUnit)
  durationUnit?: DurationUnit;

  @ApiPropertyOptional({ enum: DirectoryStatus, default: DirectoryStatus.ACTIVE })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;
}
