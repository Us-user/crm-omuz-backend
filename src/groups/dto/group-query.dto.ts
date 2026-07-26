import { ApiPropertyOptional } from '@nestjs/swagger';
import { GroupFormat, GroupStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/**
 * Поля, по которым разрешено сортировать список групп. Перечисление, а не
 * свободная строка из `PaginationQueryDto`: иначе значение дошло бы до
 * `orderBy` Prisma и вернулось ошибкой БД (500) на первом неизвестном поле.
 */
export enum GroupSortField {
  Name = 'name',
  StartDate = 'startDate',
  CreatedAt = 'createdAt',
}

/** Список групп (ТЗ 3.5, 5.5: фильтры Branch / Status / Course). */
export class GroupQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: GroupSortField, default: GroupSortField.Name })
  @IsOptional()
  @IsEnum(GroupSortField)
  override sort: GroupSortField = GroupSortField.Name;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({ format: 'uuid', description: 'Только группы этого филиала' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Только группы этого курса' })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional({ enum: GroupStatus })
  @IsOptional()
  @IsEnum(GroupStatus)
  status?: GroupStatus;

  @ApiPropertyOptional({ enum: GroupFormat })
  @IsOptional()
  @IsEnum(GroupFormat)
  format?: GroupFormat;
}
