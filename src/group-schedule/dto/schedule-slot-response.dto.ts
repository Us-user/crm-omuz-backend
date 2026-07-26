import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WeekDay } from '@prisma/client';

/** Аудитория в расписании — ровно то, что рисует ячейка календаря (ТЗ 5.10). */
export class SlotRoomDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '101' })
  name!: string;
}

/** Ментор, ведущий занятие (ТЗ 5.10). */
export class SlotMentorDto {
  @ApiProperty({ format: 'uuid', description: 'Профиль сотрудника (`Employee.id`)' })
  id!: string;

  @ApiProperty({ example: 'Фаррух' })
  firstName!: string;

  @ApiProperty({ example: 'Раҳимов' })
  lastName!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Саидович' })
  middleName!: string | null;
}

/** Слот расписания группы (ТЗ 5.5, 5.10). */
export class ScheduleSlotDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', description: 'Группа, чьё это занятие' })
  groupId!: string;

  @ApiProperty({
    enum: WeekDay,
    description: 'Занятие повторяется в этот день каждую неделю, пока идёт обучение группы',
  })
  dayOfWeek!: WeekDay;

  @ApiProperty({ example: '10:00', description: 'Начало занятия, `HH:MM`' })
  startTime!: string;

  @ApiProperty({ example: '12:00', description: 'Окончание занятия, `HH:MM`' })
  endTime!: string;

  @ApiPropertyOptional({
    type: SlotRoomDto,
    nullable: true,
    description: 'Аудитория. `null` у занятий онлайн.',
  })
  room!: SlotRoomDto | null;

  @ApiPropertyOptional({
    type: SlotMentorDto,
    nullable: true,
    description: 'Кто ведёт. `null`, если ментор занятия не назначен отдельно.',
  })
  mentor!: SlotMentorDto | null;

  @ApiProperty({ example: '2026-07-28T10:15:00.000Z' })
  createdAt!: string;
}

/** Ответ на удаление слота — чтобы интерфейс мог назвать убранное занятие. */
export class ScheduleSlotRemovedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  groupId!: string;

  @ApiProperty({ enum: WeekDay })
  dayOfWeek!: WeekDay;

  @ApiProperty({ example: '10:00' })
  startTime!: string;

  @ApiProperty({ example: '12:00' })
  endTime!: string;
}
