import { ApiPropertyOptional } from '@nestjs/swagger';
import { WeekDay } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/**
 * Поля сортировки расписания. Перечисление, а не свободная строка
 * из `PaginationQueryDto`: иначе значение дошло бы до `orderBy` Prisma
 * и вернулось ошибкой БД (500) на первом неизвестном поле.
 */
export enum ScheduleSlotSortField {
  /** «День недели, затем время» — так расписание читают на карточке группы. */
  DayOfWeek = 'dayOfWeek',
  /** Только по времени: удобно, когда смотрят, во сколько группа занимается. */
  StartTime = 'startTime',
  CreatedAt = 'createdAt',
}

/** Расписание группы (ТЗ 3.5, 5.5). */
export class ScheduleSlotQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ScheduleSlotSortField, default: ScheduleSlotSortField.DayOfWeek })
  @IsOptional()
  @IsEnum(ScheduleSlotSortField)
  override sort: ScheduleSlotSortField = ScheduleSlotSortField.DayOfWeek;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({ enum: WeekDay, description: 'Только занятия этого дня недели' })
  @IsOptional()
  @IsEnum(WeekDay)
  dayOfWeek?: WeekDay;

  @ApiPropertyOptional({ format: 'uuid', description: 'Только занятия в этой аудитории' })
  @IsOptional()
  @IsUUID()
  roomId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Только занятия этого ментора' })
  @IsOptional()
  @IsUUID()
  mentorId?: string;
}
