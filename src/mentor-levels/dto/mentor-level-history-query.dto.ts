import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, Matches } from 'class-validator';

import { ISO_MONTH_PATTERN, PageQueryDto, SortOrder, trimString } from '../../common';

/**
 * История уровня по месяцам (ТЗ 5.14).
 *
 * Наследует `PageQueryDto`, а не `PaginationQueryDto`: искать в истории нечем —
 * у записи есть только месяц и ссылка на ступень, а `search`, который есть
 * в OpenAPI и молча ничего не делает, хуже отсутствующего (сессия 0018).
 *
 * Фильтры `from`/`to` заведены сверх перечня ТЗ: зарплата считается за период
 * (ТЗ 5.16), и без них ведомость квартала пришлось бы собирать листанием.
 */
export class MentorLevelHistoryQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: ['month'],
    default: 'month',
    description: 'Сортировка только по месяцу: других полей у записи нет.',
  })
  @IsOptional()
  @IsEnum(['month'])
  override sort = 'month' as const;

  // История читается свежими сверху — как лента коинов и заметок.
  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Desc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({ example: '2026-01', description: 'С этого месяца включительно' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(ISO_MONTH_PATTERN, { message: 'from должен быть месяцем в формате YYYY-MM' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-12', description: 'По этот месяц включительно' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(ISO_MONTH_PATTERN, { message: 'to должен быть месяцем в формате YYYY-MM' })
  to?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Месяцы, в которых стоит эта ступень' })
  @IsOptional()
  @IsUUID()
  levelId?: string;
}
