import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNumber,
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
 * Потолок суммы скидки под колонку `DECIMAL(12,2)`. Без него число, не влезающее
 * в столбец, дошло бы до БД и вернулось 500 — то же, что со стоимостью курса
 * (0007) и часовой ставкой ментора (0021).
 */
export const MAX_COUPON_AMOUNT = 9_999_999_999;

/**
 * Сколько курсов принимается в мультивыборе. Каталог учебного центра — это
 * десятки курсов, а не тысячи; купон на весь каталог задаётся пустым списком.
 */
export const MAX_COUPON_COURSES = 50;

/** Дата периода либо пустая строка, стирающая её (как у сроков группы, 0008). */
const OPTIONAL_ISO_DATE = /^$|^\d{4}-\d{2}-\d{2}$/;

/** Создание купона (ТЗ 5.7: «курс(ы) + сумма (сомони) + период + Active/Inactive»). */
export class CreateCouponDto {
  @ApiProperty({ example: 'OSEN-2026', minLength: 2, maxLength: 100 })
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ maxLength: 1000, description: 'Пустая строка очищает поле.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({
    example: 250.5,
    description: 'Сумма скидки в сомони. Не больше двух знаков после запятой.',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_COUPON_AMOUNT)
  amount!: number;

  @ApiPropertyOptional({
    example: '2026-09-01',
    description: 'Начало периода `YYYY-MM-DD`, включительно. Пустая строка снимает границу.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(OPTIONAL_ISO_DATE, { message: 'validFrom должна быть датой в формате YYYY-MM-DD' })
  validFrom?: string;

  @ApiPropertyOptional({
    example: '2026-11-30',
    description: 'Конец периода `YYYY-MM-DD`, включительно. Пустая строка снимает границу.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(OPTIONAL_ISO_DATE, { message: 'validTo должна быть датой в формате YYYY-MM-DD' })
  validTo?: string;

  @ApiPropertyOptional({ enum: DirectoryStatus, default: DirectoryStatus.ACTIVE })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: MAX_COUPON_COURSES,
    description:
      'Курсы, на которые действует купон (ТЗ 5.7). **Пустой список — «на все курсы»**. ' +
      'В `PUT` переданный список заменяет набор целиком: при слиянии снять курс ' +
      'было бы нечем.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_COUPON_COURSES)
  @IsUUID(undefined, { each: true })
  courseIds?: string[];
}
