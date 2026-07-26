import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/** Поля, по которым разрешено сортировать справочник позиций. */
export enum PositionSortField {
  Name = 'name',
  CreatedAt = 'createdAt',
}

/**
 * Список позиций (ТЗ 3.5: пагинация, поиск, сортировка).
 *
 * `sort` сужен до перечисления: свободная строка из базового DTO попала бы
 * в `orderBy` Prisma и упала бы ошибкой БД на первом же неизвестном поле.
 */
export class PositionQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PositionSortField, default: PositionSortField.Name })
  @IsOptional()
  @IsEnum(PositionSortField)
  override sort: PositionSortField = PositionSortField.Name;

  // Справочник читают по алфавиту, поэтому направление по умолчанию — прямое,
  // в отличие от базового DTO, где список обычно нужен «сначала свежее».
  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;
}
