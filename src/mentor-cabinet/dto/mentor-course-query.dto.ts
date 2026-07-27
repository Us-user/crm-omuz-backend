import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/** Поля сортировки своих курсов — перечислением, как во всех списках проекта. */
export enum MentorCourseSortField {
  Title = 'title',
  CreatedAt = 'createdAt',
}

/** Свои курсы (ТЗ 3.5, 5.4 — раздел «Courses»). */
export class MentorCourseQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: MentorCourseSortField, default: MentorCourseSortField.Title })
  @IsOptional()
  @IsEnum(MentorCourseSortField)
  override sort: MentorCourseSortField = MentorCourseSortField.Title;

  // Курсов у ментора единицы, и читают их по алфавиту, а не «свежие сверху».
  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;
}
