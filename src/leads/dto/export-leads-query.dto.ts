import { ApiPropertyOptional } from '@nestjs/swagger';
import { LeadType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

import { ISO_MONTH_PATTERN, trimString } from '../../common';

/** Тот же разбор, что у `converted` в постраничном списке. */
const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/**
 * Выгрузка лидов (ТЗ 5.7: «Export»). Пагинации нет намеренно: файл, в который
 * попала одна страница из двадцати строк, не является выгрузкой воронки — то же
 * исключение из ТЗ 3.5, что у выгрузки состава группы (0013) и каталога прав (0006).
 *
 * Доменные фильтры при этом те же, что у списка, и разбираются тем же кодом:
 * «выгрузить клиентов сентября по этому курсу» — это тот же экран с теми же
 * параметрами, а не второй набор правил отбора.
 */
export class ExportLeadsQueryDto {
  @ApiPropertyOptional({ enum: LeadType, description: 'Стадия обращения (ТЗ 5.7).' })
  @IsOptional()
  @IsEnum(LeadType)
  type?: LeadType;

  @ApiPropertyOptional({ format: 'uuid', description: 'Интересующий курс.' })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Филиал записи (ТЗ 3.3).' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Обещанный купон.' })
  @IsOptional()
  @IsUUID()
  couponId?: string;

  @ApiPropertyOptional({ example: '2026-09', description: '«Месяц записи» из ТЗ 5.7.' })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'enrollMonth: ожидается месяц в формате YYYY-MM' })
  enrollMonth?: string;

  @ApiPropertyOptional({ description: 'Переведён ли лид в студенты.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  converted?: boolean;

  @ApiPropertyOptional({
    example: '2026-01',
    description: 'Начало периода обращения: месяц `YYYY-MM` включительно.',
  })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'from: ожидается месяц в формате YYYY-MM' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-06',
    description: 'Конец периода обращения: месяц `YYYY-MM` включительно.',
  })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'to: ожидается месяц в формате YYYY-MM' })
  to?: string;

  @ApiPropertyOptional({
    description: 'Поиск по имени, фамилии, телефону, почте, источнику и UTM-кампании.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  search?: string;
}
