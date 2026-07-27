import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WeekDay } from '@prisma/client';

/** Группа занятия — чтобы строка расписания читалась без второго запроса. */
export class MeSlotGroupDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend-1' })
  name!: string;

  @ApiProperty({ format: 'uuid' })
  courseId!: string;

  @ApiProperty({ example: 'Frontend Basic' })
  courseTitle!: string;
}

/** Аудитория занятия (ТЗ 5.10). */
export class MeSlotRoomDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '101' })
  name!: string;
}

/** Кто ведёт занятие (ТЗ 5.10). */
export class MeSlotMentorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Фаррух' })
  firstName!: string;

  @ApiProperty({ example: 'Раҳимов' })
  lastName!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Саидович' })
  middleName!: string | null;
}

/**
 * Занятие в расписании студента (ТЗ 5.3: кабинет — «расписание»).
 *
 * Слот повторяется **еженедельно** (решение сессии 0011): это «понедельник,
 * 10:00–12:00», а не конкретная дата. Разворот в календарь Day/Week/Month
 * (ТЗ 5.10) — Фаза 10.
 */
export class MeScheduleSlotDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: MeSlotGroupDto })
  group!: MeSlotGroupDto;

  @ApiProperty({ enum: WeekDay, description: 'Занятие повторяется в этот день каждую неделю' })
  dayOfWeek!: WeekDay;

  @ApiProperty({ example: '10:00', description: 'Начало занятия, `HH:MM`' })
  startTime!: string;

  @ApiProperty({ example: '12:00', description: 'Окончание занятия, `HH:MM`' })
  endTime!: string;

  @ApiPropertyOptional({
    type: MeSlotRoomDto,
    nullable: true,
    description: 'Аудитория. `null` у занятий онлайн.',
  })
  room!: MeSlotRoomDto | null;

  @ApiPropertyOptional({
    type: MeSlotMentorDto,
    nullable: true,
    description: 'Кто ведёт. `null`, если ментор занятия не назначен отдельно.',
  })
  mentor!: MeSlotMentorDto | null;
}
