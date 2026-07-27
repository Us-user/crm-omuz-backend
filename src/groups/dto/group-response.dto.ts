import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DurationUnit, GroupFormat, GroupStatus } from '@prisma/client';

/** Курс группы — коротко, чтобы список не требовал второго запроса. */
export class GroupCourseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend Basic' })
  title!: string;

  @ApiProperty({
    example: false,
    description: '«Is last course» курса: по такой группе пойдёт автовыпуск (ТЗ 5.11)',
  })
  isLastCourse!: boolean;
}

/** Филиал группы (ТЗ 3.3). */
export class GroupBranchDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sadbarg' })
  name!: string;
}

/**
 * Счётчики категорий активности группы (ТЗ 5.5).
 *
 * Считаются по действующему составу, каждому — свой средний `Sum`
 * **по закрытым неделям этой группы**: счётчики стоят на карточке группы,
 * и от учёбы человека на соседнем курсе они сдвигаться не должны.
 *
 * Имена полей — те же категории, что в `activityCategory` карточки студента
 * (ТЗ 5.5): `chatGpt` ≥95 · `handsome` 80–94 · `advanced` 65–79 ·
 * `kettle` 45–64 · `blackList` <45.
 */
export class GroupActivityDto {
  @ApiProperty({ example: 2, description: 'ChatGPT: балл ≥ 95' })
  chatGpt!: number;

  @ApiProperty({ example: 5, description: 'Handsome: 80–94' })
  handsome!: number;

  @ApiProperty({ example: 3, description: 'Advanced: 65–79' })
  advanced!: number;

  @ApiProperty({ example: 1, description: 'Kettle: 45–64' })
  kettle!: number;

  @ApiProperty({ example: 0, description: 'Black list: балл < 45' })
  blackList!: number;

  @ApiProperty({
    example: 1,
    description:
      'Ещё не оценённые: в группе нет ни одной финализированной недели с их участием. ' +
      'Считаются отдельно от Black list — «не оценён» и «не справляется» разные вещи.',
  })
  unscored!: number;
}

/** Учебная группа (ТЗ 5.5). */
export class GroupDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend-1' })
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiProperty({ type: GroupCourseDto })
  course!: GroupCourseDto;

  @ApiProperty({ type: GroupBranchDto })
  branch!: GroupBranchDto;

  @ApiProperty({ enum: GroupFormat })
  format!: GroupFormat;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-09-01',
    description: 'Календарная дата без времени: в столбце времени нет',
  })
  startDate!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-09-30' })
  endDate!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 1 })
  durationValue!: number | null;

  @ApiProperty({ enum: DurationUnit })
  durationUnit!: DurationUnit;

  @ApiPropertyOptional({
    nullable: true,
    example: 16,
    description: '«Required students» — вместимость набора (ТЗ 5.5)',
  })
  capacity!: number | null;

  @ApiProperty({
    example: 12,
    description:
      'Сколько студентов учится в группе сейчас — вторая половина «Required students = ' +
      'набрано/вместимость» (ТЗ 5.5). Покинувшие и завершившие не считаются. ' +
      'Набор сверх `capacity` не запрещён: это плановая цифра, а не предел.',
  })
  enrolledCount!: number;

  @ApiProperty({
    example: 11,
    description:
      '«Passing students» (ТЗ 5.5): сколько из действующего состава успевают — ' +
      'то есть имеют балл не ниже 45 и не попали в Black list. Ещё не оценённые ' +
      'сюда не входят.',
  })
  passingCount!: number;

  @ApiProperty({
    type: GroupActivityDto,
    description: 'Счётчики категорий активности (ТЗ 5.5) по действующему составу.',
  })
  activity!: GroupActivityDto;

  @ApiProperty({ enum: GroupStatus })
  status!: GroupStatus;

  @ApiPropertyOptional({ nullable: true, example: 'https://t.me/omuz_frontend_1' })
  telegramUrl!: string | null;

  @ApiProperty({ example: '2026-07-27T10:15:00.000Z' })
  createdAt!: string;
}

/** Ответ на удаление — чтобы интерфейс мог назвать удалённое. */
export class GroupDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend-1' })
  name!: string;
}
