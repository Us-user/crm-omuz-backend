import { ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/** Поля, по которым разрешено сортировать список аудиторий. */
export enum RoomSortField {
  Name = 'name',
  Capacity = 'capacity',
  CreatedAt = 'createdAt',
}

/** Список аудиторий (ТЗ 3.5) с доменным фильтром по филиалу (ТЗ 3.3). */
export class RoomQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: RoomSortField, default: RoomSortField.Name })
  @IsOptional()
  @IsEnum(RoomSortField)
  override sort: RoomSortField = RoomSortField.Name;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({ format: 'uuid', description: 'Показать аудитории одного филиала' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ enum: DirectoryStatus })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;
}
