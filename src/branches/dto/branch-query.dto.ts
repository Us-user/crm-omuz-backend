import { ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/** Поля, по которым разрешено сортировать список филиалов. */
export enum BranchSortField {
  Name = 'name',
  City = 'city',
  CreatedAt = 'createdAt',
}

/**
 * Список филиалов (ТЗ 3.5: пагинация, поиск, фильтры).
 *
 * `sort` сужен до перечисления: свободная строка из базового DTO попала бы
 * в `orderBy` Prisma и вернулась бы ошибкой БД на первом же неизвестном поле.
 */
export class BranchQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: BranchSortField, default: BranchSortField.Name })
  @IsOptional()
  @IsEnum(BranchSortField)
  override sort: BranchSortField = BranchSortField.Name;

  // Справочник читают по алфавиту, поэтому направление по умолчанию прямое.
  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({ enum: DirectoryStatus, description: 'Фильтр по статусу филиала' })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;
}
