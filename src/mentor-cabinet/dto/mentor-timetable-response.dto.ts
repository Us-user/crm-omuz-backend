import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WeekDay } from '@prisma/client';

/** Группа занятия — с курсом, чтобы календарь не догружал каталог построчно. */
export class MentorSlotGroupDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend-1' })
  name!: string;

  @ApiProperty({ format: 'uuid' })
  courseId!: string;

  @ApiProperty({ example: 'Frontend' })
  courseTitle!: string;
}

/** Аудитория занятия (ТЗ 5.10). `null` — занятие онлайн. */
export class MentorSlotRoomDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '101' })
  name!: string;
}

/** Кто ведёт занятие (ТЗ 5.10 показывает ментора в календаре). */
export class MentorSlotMentorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Фаррух' })
  firstName!: string;

  @ApiProperty({ example: 'Раҳимов' })
  lastName!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Азизович' })
  middleName!: string | null;
}

/**
 * Занятие в расписании ментора (ТЗ 5.4, раздел «Timetable»).
 *
 * Слот повторяется **еженедельно** (решение сессии 0011): это «понедельник,
 * 10:00–12:00», а не дата. Разворот в календарь Day/Week/Month (ТЗ 5.10)
 * появится с общим `/timetable` в Фазе 10.
 */
export class MentorTimetableSlotDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: MentorSlotGroupDto })
  group!: MentorSlotGroupDto;

  @ApiProperty({ enum: WeekDay })
  dayOfWeek!: WeekDay;

  @ApiProperty({ example: '10:00', description: 'Начало занятия, HH:MM' })
  startTime!: string;

  @ApiProperty({ example: '12:00', description: 'Окончание занятия, HH:MM' })
  endTime!: string;

  @ApiPropertyOptional({ type: MentorSlotRoomDto, nullable: true })
  room!: MentorSlotRoomDto | null;

  @ApiPropertyOptional({
    type: MentorSlotMentorDto,
    nullable: true,
    description: 'Назначенный ведущий; `null` — на слоте он не проставлен',
  })
  mentor!: MentorSlotMentorDto | null;

  @ApiProperty({
    example: true,
    description:
      'Веду ли это занятие лично. `false` — занятие моей группы, назначенное коллеге ' +
      'или без назначенного ведущего: ведущий на слоте необязателен (сессия 0011), ' +
      'поэтому расписание собирается от менторства, а не от него.',
  })
  mine!: boolean;
}
