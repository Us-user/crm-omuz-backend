import { ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceFileType, ResourceKind } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/** Поля сортировки материалов урока — перечисление, а не свободная строка. */
export enum ResourceFileSortField {
  Title = 'title',
  CreatedAt = 'createdAt',
}

/** Материалы урока (ТЗ 3.5, 5.6). */
export class ResourceFileQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ResourceFileSortField, default: ResourceFileSortField.CreatedAt })
  @IsOptional()
  @IsEnum(ResourceFileSortField)
  override sort: ResourceFileSortField = ResourceFileSortField.CreatedAt;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({ enum: ResourceKind, description: 'Только материалы этого раздела урока' })
  @IsOptional()
  @IsEnum(ResourceKind)
  kind?: ResourceKind;

  @ApiPropertyOptional({ enum: ResourceFileType })
  @IsOptional()
  @IsEnum(ResourceFileType)
  fileType?: ResourceFileType;
}
