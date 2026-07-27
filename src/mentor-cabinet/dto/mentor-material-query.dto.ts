import { ApiPropertyOptional } from '@nestjs/swagger';
import { LessonType } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/** Поля сортировки материалов — перечислением, как в силлабусе (сессия 0009). */
export enum MentorMaterialSortField {
  /** Порядок учебных дней — так программу и читают. */
  DayNumber = 'dayNumber',
  Title = 'title',
  CreatedAt = 'createdAt',
}

/** Свои материалы (ТЗ 3.5, 5.4 — раздел «Material»; «Show to group» — ТЗ 5.6). */
export class MentorMaterialQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: MentorMaterialSortField,
    default: MentorMaterialSortField.DayNumber,
  })
  @IsOptional()
  @IsEnum(MentorMaterialSortField)
  override sort: MentorMaterialSortField = MentorMaterialSortField.DayNumber;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Только материалы, открытые этой группе. Группа должна быть своей — иначе 422 ' +
      '(тем же ответом отвечает и несуществующая группа).',
  })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Только уроки этого курса. Неизвестный или чужой курс даёт пустой список: ' +
      'выборка и так сужена своими группами, поэтому проверять его отдельно нечего.',
  })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional({ enum: LessonType, description: 'Тип занятия (ТЗ 5.6)' })
  @IsOptional()
  @IsEnum(LessonType)
  type?: LessonType;
}
