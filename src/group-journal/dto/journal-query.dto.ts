import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';

import { PageQueryDto, SortOrder } from '../../common';

/**
 * Поля сортировки недель журнала. Перечисление, а не свободная строка:
 * иначе значение дошло бы до `orderBy` Prisma и вернулось ошибкой БД (500).
 */
export enum JournalWeekSortField {
  WeekNumber = 'weekNumber',
  StartDate = 'startDate',
}

const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true') return true;
  if (value === 'false') return false;

  return value;
};

/**
 * Журнал группы — список недель (ТЗ 3.5, 5.8).
 *
 * Наследуется от `PageQueryDto`, а не от `PaginationQueryDto`: у недели нет
 * ни названия, ни описания, и полнотекстовый поиск искал бы в ней по пустому
 * месту. Параметр, который есть в OpenAPI и молча ничего не делает, хуже
 * отсутствующего.
 */
export class JournalQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: JournalWeekSortField, default: JournalWeekSortField.WeekNumber })
  @IsOptional()
  @IsEnum(JournalWeekSortField)
  override sort: JournalWeekSortField = JournalWeekSortField.WeekNumber;

  @ApiPropertyOptional({
    enum: SortOrder,
    default: SortOrder.Asc,
    description: 'По умолчанию по возрастанию: журнал читают от первой недели к последней.',
  })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({
    description:
      'Только финализированные (`true`) или только открытые (`false`) недели. ' +
      'Финализация — «Отправить результат» из ТЗ 5.8.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  submitted?: boolean;
}
