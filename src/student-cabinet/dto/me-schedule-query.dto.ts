import { ApiPropertyOptional } from '@nestjs/swagger';
import { WeekDay } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/** Поля сортировки своего расписания — перечислением, как у расписания группы. */
export enum MeScheduleSortField {
  /** «День недели, затем время» — так расписание и читают. */
  DayOfWeek = 'dayOfWeek',
  /** Только по времени: во сколько занятия на этой неделе. */
  StartTime = 'startTime',
}

/** Своё расписание (ТЗ 3.5, 5.3). */
export class MeScheduleQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: MeScheduleSortField, default: MeScheduleSortField.DayOfWeek })
  @IsOptional()
  @IsEnum(MeScheduleSortField)
  override sort: MeScheduleSortField = MeScheduleSortField.DayOfWeek;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({ enum: WeekDay, description: 'Только занятия этого дня недели' })
  @IsOptional()
  @IsEnum(WeekDay)
  dayOfWeek?: WeekDay;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Только занятия этой группы. Группа должна быть своей и действующей — иначе 422 ' +
      '(тем же ответом отвечает и несуществующая группа).',
  })
  @IsOptional()
  @IsUUID()
  groupId?: string;
}
