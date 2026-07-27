import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StudentStatus } from '@prisma/client';

/** Кто ушёл. */
export class LeftCourseStudentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Нигина' })
  firstName!: string;

  @ApiProperty({ example: 'Каримова' })
  lastName!: string;

  @ApiProperty({ example: '+992901234567' })
  phone!: string;

  @ApiPropertyOptional({ nullable: true, example: 'https://cdn.omuz.tj/students/1.jpg' })
  photoUrl!: string | null;

  @ApiProperty({
    enum: StudentStatus,
    description:
      'Статус профиля (ТЗ 5.12 описывает витрину как «студенты со статусом No Active»). ' +
      'Он выводится из **всех** членств человека, поэтому у ушедшего с одного курса ' +
      'и продолжающего на другом здесь будет `ACTIVE`: строка отчёта — про покинутый ' +
      'курс, а статус — про человека целиком.',
  })
  status!: StudentStatus;
}

/** Именованная ссылка: группа, курс или филиал. */
export class LeftCourseRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend-1' })
  name!: string;
}

/** Ментор на момент ухода (ТЗ 5.12). */
export class LeftCourseMentorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Фаррух' })
  firstName!: string;

  @ApiProperty({ example: 'Раҳимов' })
  lastName!: string;
}

/** Строка витрины покинувших курсы (ТЗ 5.12). */
export class LeftCourseDto {
  @ApiProperty({ type: LeftCourseStudentDto })
  student!: LeftCourseStudentDto;

  @ApiProperty({ type: LeftCourseRefDto, description: 'Группа, которую студент покинул.' })
  group!: LeftCourseRefDto;

  @ApiProperty({ type: LeftCourseRefDto, description: 'Курс покинутой группы.' })
  course!: LeftCourseRefDto;

  @ApiProperty({ type: LeftCourseRefDto, description: 'Филиал покинутой группы (ТЗ 3.3).' })
  branch!: LeftCourseRefDto;

  @ApiPropertyOptional({
    type: LeftCourseMentorDto,
    nullable: true,
    description:
      'Ведущий ментор группы **на момент ухода** — снимок, зафиксированный при смене ' +
      'статуса, а не текущий состав менторов. `null` — у группы не было ведущего ментора ' +
      'либо уход оформлен до появления снимка.',
  })
  mentor!: LeftCourseMentorDto | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Переезд в другой город',
    description: 'Причина ухода — свободный текст (ТЗ 5.12), обязательный при смене статуса.',
  })
  reason!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-06-14T08:30:00.000Z',
    description: 'Дата ухода. `null` — у строк, закрытых до появления правила.',
  })
  leftAt!: string | null;

  @ApiProperty({ example: '2026-02-01T00:00:00.000Z', description: 'Когда студент был зачислен.' })
  enrolledAt!: string;
}

/** Столбец помесячного графика (ТЗ 5.12). */
export class LeftCourseMonthDto {
  @ApiProperty({ example: '2026-06' })
  month!: string;

  @ApiProperty({ example: 3, description: 'Сколько уходов пришлось на этот месяц.' })
  count!: number;
}

/** Разрез «вид Groups» из ТЗ 5.12. */
export class LeftCourseGroupStatDto {
  @ApiProperty({ type: LeftCourseRefDto })
  group!: LeftCourseRefDto;

  @ApiProperty({ type: LeftCourseRefDto })
  course!: LeftCourseRefDto;

  @ApiProperty({ example: 4 })
  count!: number;
}

/** Разрез по курсу или филиалу. */
export class LeftCourseRefStatDto {
  @ApiProperty({ type: LeftCourseRefDto })
  ref!: LeftCourseRefDto;

  @ApiProperty({ example: 7 })
  count!: number;
}

/** Статистика оттока за период (ТЗ 5.12). */
export class LeftCoursesStatsDto {
  @ApiProperty({ example: '2025-08', description: 'Первый месяц периода включительно.' })
  from!: string;

  @ApiProperty({ example: '2026-07', description: 'Последний месяц периода включительно.' })
  to!: string;

  @ApiProperty({ example: 42, description: 'Всего уходов за период.' })
  total!: number;

  @ApiProperty({
    type: [LeftCourseMonthDto],
    description:
      'Помесячный график по возрастанию. Месяцы без уходов остаются в ряду с нулём — ' +
      'иначе расстояние между столбцами перестало бы быть временем.',
  })
  byMonth!: LeftCourseMonthDto[];

  @ApiProperty({
    type: [LeftCourseGroupStatDto],
    description: 'Разрез по группам, по убыванию числа уходов.',
  })
  byGroup!: LeftCourseGroupStatDto[];

  @ApiProperty({ type: [LeftCourseRefStatDto], description: 'Разрез по курсам.' })
  byCourse!: LeftCourseRefStatDto[];

  @ApiProperty({ type: [LeftCourseRefStatDto], description: 'Разрез по филиалам (ТЗ 3.3).' })
  byBranch!: LeftCourseRefStatDto[];
}
