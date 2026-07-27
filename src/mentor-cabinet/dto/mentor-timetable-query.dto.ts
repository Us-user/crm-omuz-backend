import { ApiPropertyOptional } from '@nestjs/swagger';
import { WeekDay } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/** Поля сортировки своего расписания — перечислением, как у расписания группы. */
export enum MentorTimetableSortField {
  /** «День недели, затем время» — так расписание и читают. */
  DayOfWeek = 'dayOfWeek',
  /** Только по времени: во сколько занятия на этой неделе. */
  StartTime = 'startTime',
}

/** Своё расписание (ТЗ 3.5, 5.4 — раздел «Timetable»; форма слота — ТЗ 5.5). */
export class MentorTimetableQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: MentorTimetableSortField,
    default: MentorTimetableSortField.DayOfWeek,
  })
  @IsOptional()
  @IsEnum(MentorTimetableSortField)
  override sort: MentorTimetableSortField = MentorTimetableSortField.DayOfWeek;

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
      'Только занятия этой группы. Группа должна быть своей — иначе 422 ' +
      '(тем же ответом отвечает и несуществующая группа).',
  })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({
    description:
      '`true` — только занятия, которые сотрудник ведёт лично (`mine`); ' +
      '`false` — только занятия его групп, которые ведёт кто-то другой либо ' +
      'ведущий не назначен. Без параметра — все занятия своих групп.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  onlyMine?: boolean;
}
