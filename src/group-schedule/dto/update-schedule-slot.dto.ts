import { ApiPropertyOptional } from '@nestjs/swagger';
import { WeekDay } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Matches } from 'class-validator';

import { DAY_TIME_PATTERN, trimString } from '../../common';
import { UUID_OR_EMPTY } from './create-schedule-slot.dto';

/**
 * Правка слота расписания (ТЗ 5.5).
 *
 * Не `PartialType(CreateScheduleSlotDto)`: у ссылок здесь другая валидация —
 * пустая строка снимает аудиторию или ментора, а `@IsUUID()` её не пропустил бы.
 * Не переданное поле не меняется.
 */
export class UpdateScheduleSlotDto {
  @ApiPropertyOptional({ enum: WeekDay })
  @IsOptional()
  @IsEnum(WeekDay)
  dayOfWeek?: WeekDay;

  @ApiPropertyOptional({ example: '10:00', description: 'Начало занятия, `HH:MM`' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(DAY_TIME_PATTERN, { message: 'startTime должно быть временем в формате HH:MM' })
  startTime?: string;

  @ApiPropertyOptional({ example: '12:00', description: 'Окончание занятия, `HH:MM`' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(DAY_TIME_PATTERN, { message: 'endTime должно быть временем в формате HH:MM' })
  endTime?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Аудитория из филиала группы. Пустая строка убирает аудиторию из слота.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(UUID_OR_EMPTY, { message: 'roomId должен быть UUID или пустой строкой' })
  roomId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Ментор из состава группы. Пустая строка убирает ментора из слота.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(UUID_OR_EMPTY, { message: 'mentorId должен быть UUID или пустой строкой' })
  mentorId?: string;
}
