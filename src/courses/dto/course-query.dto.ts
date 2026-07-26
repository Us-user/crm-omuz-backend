import { ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/** Поля, по которым разрешено сортировать каталог курсов. */
export enum CourseSortField {
  Title = 'title',
  Fee = 'fee',
  CreatedAt = 'createdAt',
}

/** Приводит `"true"/"false"` из query-строки к булеву значению. */
const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true') return true;
  if (value === 'false') return false;

  return value;
};

/** Каталог курсов (ТЗ 3.5, 5.6). */
export class CourseQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: CourseSortField, default: CourseSortField.Title })
  @IsOptional()
  @IsEnum(CourseSortField)
  override sort: CourseSortField = CourseSortField.Title;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({ enum: DirectoryStatus })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;

  @ApiPropertyOptional({
    description: 'Только последние курсы программы (или только не последние)',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isLastCourse?: boolean;
}
