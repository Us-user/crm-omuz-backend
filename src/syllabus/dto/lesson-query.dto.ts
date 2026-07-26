import { ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus, LessonType } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/**
 * Поля сортировки программы курса. Перечисление, а не свободная строка
 * из `PaginationQueryDto`: иначе значение дошло бы до `orderBy` Prisma
 * и вернулось ошибкой БД (500) на первом неизвестном поле.
 */
export enum LessonSortField {
  DayNumber = 'dayNumber',
  Title = 'title',
  CreatedAt = 'createdAt',
}

/** Программа курса (ТЗ 3.5, 5.6). */
export class LessonQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: LessonSortField, default: LessonSortField.DayNumber })
  @IsOptional()
  @IsEnum(LessonSortField)
  override sort: LessonSortField = LessonSortField.DayNumber;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({ enum: LessonType, description: 'Только занятия этого типа' })
  @IsOptional()
  @IsEnum(LessonType)
  type?: LessonType;

  @ApiPropertyOptional({ enum: DirectoryStatus })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Только уроки, открытые этой группе («Show to group», ТЗ 5.6) — то, что видит ' +
      'ментор на экране «Material» (ТЗ 5.4)',
  })
  @IsOptional()
  @IsUUID()
  groupId?: string;
}
