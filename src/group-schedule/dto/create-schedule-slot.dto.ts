import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WeekDay } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, Matches } from 'class-validator';

import { DAY_TIME_PATTERN, trimString } from '../../common';

/**
 * Идентификатор **или пустая строка**. Пустая строка — «снять аудиторию
 * (ментора)», то же правило, что для текстовых полей и дат в других модулях:
 * без неё поставленную по ошибке аудиторию нельзя было бы убрать через `PUT`.
 */
export const UUID_OR_EMPTY = /^$|^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

/** Слот расписания группы (ТЗ 5.5: «расписание (слоты день+время → Timetable)»). */
export class CreateScheduleSlotDto {
  @ApiProperty({
    enum: WeekDay,
    description:
      'День недели. Слот повторяется еженедельно в пределах сроков группы, ' +
      'поэтому конкретная дата не задаётся.',
  })
  @IsEnum(WeekDay)
  dayOfWeek!: WeekDay;

  @ApiProperty({
    example: '10:00',
    description: 'Начало занятия, `HH:MM` (24 часа)',
  })
  @Transform(trimString)
  @IsString()
  @Matches(DAY_TIME_PATTERN, { message: 'startTime должно быть временем в формате HH:MM' })
  startTime!: string;

  @ApiProperty({
    example: '12:00',
    description: 'Окончание занятия, `HH:MM`. Должно быть позже начала.',
  })
  @Transform(trimString)
  @IsString()
  @Matches(DAY_TIME_PATTERN, { message: 'endTime должно быть временем в формате HH:MM' })
  endTime!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Аудитория (ТЗ 5.10). Только из филиала группы. Не указывается для занятий онлайн.',
  })
  @IsOptional()
  @IsUUID()
  roomId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Кто ведёт занятие (`Employee.id`). Только из числа менторов группы — ' +
      'назначить постороннего сотрудника нельзя.',
  })
  @IsOptional()
  @IsUUID()
  mentorId?: string;
}
