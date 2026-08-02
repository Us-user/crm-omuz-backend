import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GroupFormat, GroupStatus, LessonType, WeekDay } from '@prisma/client';

import { TimetableView } from '../timetable';

/** Именованная ссылка календаря: курс, филиал или аудитория. */
export class TimetableRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend' })
  name!: string;
}

/** Ведущий занятия (ТЗ 5.10). */
export class TimetableMentorDto {
  @ApiProperty({ format: 'uuid', description: 'Профиль сотрудника (`Employee.id`)' })
  id!: string;

  @ApiProperty({ example: 'Фаррух' })
  firstName!: string;

  @ApiProperty({ example: 'Раҳимов' })
  lastName!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Саидович' })
  middleName!: string | null;
}

/** Группа занятия. Формат стоит рядом со статусом: онлайн-занятие идёт без аудитории. */
export class TimetableGroupDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend-1' })
  name!: string;

  @ApiProperty({ enum: GroupFormat })
  format!: GroupFormat;

  @ApiProperty({ enum: GroupStatus })
  status!: GroupStatus;
}

/** Занятие в конкретной дате — еженедельный слот, развёрнутый календарём. */
export class TimetableLessonDto {
  @ApiProperty({ format: 'uuid', description: 'Слот расписания, из которого выведено занятие' })
  slotId!: string;

  @ApiProperty({ example: '2026-09-14', description: 'Дата занятия, `YYYY-MM-DD`' })
  date!: string;

  @ApiProperty({ enum: WeekDay })
  weekDay!: WeekDay;

  @ApiProperty({ example: '10:00', description: 'Начало, `HH:MM`' })
  startTime!: string;

  @ApiProperty({ example: '12:00', description: 'Окончание, `HH:MM`' })
  endTime!: string;

  @ApiProperty({ type: TimetableGroupDto })
  group!: TimetableGroupDto;

  @ApiProperty({ type: TimetableRefDto, description: 'Курс группы' })
  course!: TimetableRefDto;

  @ApiProperty({ type: TimetableRefDto, description: 'Филиал группы (ТЗ 3.3)' })
  branch!: TimetableRefDto;

  @ApiPropertyOptional({
    type: TimetableRefDto,
    nullable: true,
    description: 'Аудитория (ТЗ 5.10). `null` у занятий онлайн.',
  })
  room!: TimetableRefDto | null;

  @ApiPropertyOptional({
    type: TimetableMentorDto,
    nullable: true,
    description: 'Ведущий, проставленный на слоте. `null`, если его не назначали.',
  })
  mentor!: TimetableMentorDto | null;

  @ApiPropertyOptional({
    enum: LessonType,
    nullable: true,
    description:
      'Тип занятия (ТЗ 5.10, колонка «Type») — из **журнала**, а не из слота. У слота ' +
      'типа нет и быть не может: он повторяется еженедельно, и каждый понедельник — ' +
      'это другой день программы (решение сессии 0011). `null` означает, что дня ' +
      'журнала на эту дату ещё нет — обычно это будущее занятие.',
  })
  type!: LessonType | null;

  @ApiProperty({
    example: true,
    description:
      'Заведён ли день журнала на эту дату: занятие **проведено**, а не только ' +
      'запланировано. Слот описывает план, журнал фиксирует факт (решение сессии 0018).',
  })
  held!: boolean;
}

/** Столбец календаря. Дни без занятий остаются в ряду с пустым списком. */
export class TimetableDayDto {
  @ApiProperty({ example: '2026-09-14' })
  date!: string;

  @ApiProperty({ enum: WeekDay })
  weekDay!: WeekDay;

  @ApiProperty({ type: [TimetableLessonDto] })
  lessons!: TimetableLessonDto[];
}

/** Календарь занятий всех групп за окно (ТЗ 5.10). */
export class TimetableDto {
  @ApiProperty({ enum: TimetableView })
  view!: TimetableView;

  @ApiProperty({ example: '2026-09-14', description: 'Начало окна включительно' })
  from!: string;

  @ApiProperty({ example: '2026-09-20', description: 'Конец окна включительно' })
  to!: string;

  @ApiProperty({ example: 12, description: 'Сколько занятий в окне — сумма по всем дням' })
  total!: number;

  @ApiProperty({
    type: [TimetableDayDto],
    description: 'Дни окна подряд, включая дни без занятий: ряд задаёт ось календаря.',
  })
  days!: TimetableDayDto[];
}
