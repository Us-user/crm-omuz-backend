import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GroupStudentStatus } from '@prisma/client';

import { ActivityCategory } from '../performance';

/** Кому принадлежит витрина — чтобы экран не запрашивал карточку отдельно. */
export class PerformanceStudentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Нигина' })
  firstName!: string;

  @ApiProperty({ example: 'Каримова' })
  lastName!: string;
}

/**
 * Место в рейтинге центра (ТЗ 5.13) и корона (ТЗ 5.3: «топ-студент»).
 *
 * В рейтинг идут только те, кто учится сейчас (решение сессии 0019), поэтому
 * у выпускника и покинувшего курс места нет — при живом общем балле.
 */
export class PerformanceRankDto {
  @ApiPropertyOptional({
    nullable: true,
    example: 3,
    description: '№ в рейтинге, с 1. `null` — студент в рейтинг не входит.',
  })
  position!: number | null;

  @ApiProperty({
    example: 42,
    description: 'Сколько всего студентов участвует в рейтинге сейчас.',
  })
  totalRanked!: number;

  @ApiProperty({
    example: false,
    description: 'Корона (ТЗ 5.3): №1 рейтинга. При равенстве баллов корона у всех первых.',
  })
  isTopStudent!: boolean;

  @ApiProperty({
    example: true,
    description:
      'Участвует ли студент в рейтинге. `false` — нет действующего членства ' +
      'либо ни одной финализированной недели.',
  })
  ranked!: boolean;
}

/**
 * Посещаемость (ТЗ 5.2: график Late/Absent; ТЗ 5.5: «absence за период»).
 *
 * Считается по **всем** отмеченным дням журнала, а не только по закрытым
 * неделям: пропуск — это факт, а не начисление, и ждать финализации, чтобы
 * его увидеть, незачем. Неотмеченные клетки сюда не попадают.
 */
export class PerformanceAttendanceDto {
  @ApiProperty({ example: 20 })
  present!: number;

  @ApiProperty({ example: 3 })
  late!: number;

  @ApiProperty({ example: 2 })
  absent!: number;

  @ApiProperty({ example: 25, description: 'Сколько дней вообще отмечено.' })
  marked!: number;

  @ApiPropertyOptional({
    nullable: true,
    example: 92,
    description:
      'Доля приходов в процентах: опоздание считается приходом (ТЗ 5.8). ' +
      '`null` — отмеченных дней нет.',
  })
  attendanceRate!: number | null;
}

/**
 * Успеваемость в одной группе. Разрез по группам нужен потому, что общий балл
 * усредняет учёбу на разных курсах в одно число, а карточке группы (ТЗ 5.5)
 * нужен балл именно в ней.
 */
export class PerformanceGroupDto {
  @ApiProperty({ format: 'uuid' })
  groupId!: string;

  @ApiProperty({ example: 'Frontend-1' })
  groupName!: string;

  @ApiProperty({ format: 'uuid' })
  courseId!: string;

  @ApiProperty({ example: 'Frontend Basic' })
  courseTitle!: string;

  @ApiProperty({
    enum: GroupStudentStatus,
    description: 'Статус членства: закрытые группы остаются в истории студента.',
  })
  membershipStatus!: GroupStudentStatus;

  @ApiPropertyOptional({
    nullable: true,
    example: 91.5,
    description: 'Средний Sum по финализированным неделям этой группы.',
  })
  averageScore!: number | null;

  @ApiPropertyOptional({ enum: ActivityCategory, nullable: true })
  category!: ActivityCategory | null;

  @ApiPropertyOptional({ nullable: true, example: 'ChatGPT' })
  categoryTitle!: string | null;

  @ApiProperty({ example: 4, description: 'Сколько закрытых недель учтено в этой группе.' })
  weeksCount!: number;
}

/** Итог одной недели — из этого экран строит график ТЗ 5.8. */
export class PerformanceWeekDto {
  @ApiProperty({ format: 'uuid' })
  weekId!: string;

  @ApiProperty({ example: 3 })
  weekNumber!: number;

  @ApiProperty({ format: 'uuid' })
  groupId!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Frontend-1',
    description:
      '`null` — студента убрали из состава группы, а его итоги в её неделях остались ' +
      '(отметка ссылается на студента, а не на членство).',
  })
  groupName!: string | null;

  @ApiProperty({ example: '2026-09-07', description: 'Начало недели, YYYY-MM-DD' })
  startDate!: string;

  @ApiProperty({ example: 6 })
  bonus!: number;

  @ApiProperty({ example: 90 })
  exam!: number;

  @ApiProperty({ example: 106, description: 'Σ(приходы) + Σ(ДЗ) + Exam + Bonus (ТЗ 5.8)' })
  sum!: number;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-09-14T09:00:00.000Z',
    description: 'Когда неделя финализирована.',
  })
  submittedAt!: string | null;
}

/**
 * Успеваемость студента (`GET /students/{id}/performance`, ТЗ 5.3).
 *
 * Общий балл — среднее `Sum` по финализированным неделям (ТЗ 5.8); из него
 * выводятся категория активности (ТЗ 5.5), место в рейтинге и корона (ТЗ 5.13).
 */
export class StudentPerformanceDto {
  @ApiProperty({ type: PerformanceStudentDto })
  student!: PerformanceStudentDto;

  @ApiPropertyOptional({
    nullable: true,
    example: 87.33,
    description:
      'Общий балл: среднее Sum по всем финализированным неделям студента. ' +
      '`null` — закрытых недель ещё нет, и балла у студента не существует ' +
      '(ноль означал бы «учился и не набрал»).',
  })
  averageScore!: number | null;

  @ApiPropertyOptional({
    enum: ActivityCategory,
    nullable: true,
    description: 'Категория активности (ТЗ 5.5), выведенная из общего балла.',
  })
  category!: ActivityCategory | null;

  @ApiPropertyOptional({ nullable: true, example: 'Handsome' })
  categoryTitle!: string | null;

  @ApiProperty({
    example: true,
    description: 'Успевающий ли (ТЗ 5.5: «Passing students») — балл не ниже 45.',
  })
  passing!: boolean;

  @ApiProperty({ example: 6, description: 'Сколько финализированных недель учтено в общем балле.' })
  weeksCount!: number;

  @ApiProperty({ type: PerformanceRankDto })
  rank!: PerformanceRankDto;

  @ApiProperty({ type: PerformanceAttendanceDto })
  attendance!: PerformanceAttendanceDto;

  @ApiProperty({
    type: [PerformanceGroupDto],
    description:
      'Разрез по группам, включая закрытые членства и группы, в которых ещё ' +
      'ни одной недели не закрыли (у таких балл `null`).',
  })
  groups!: PerformanceGroupDto[];

  @ApiProperty({
    type: [PerformanceWeekDto],
    description: 'Закрытые недели от свежих к старым — данные графика ТЗ 5.8.',
  })
  weeks!: PerformanceWeekDto[];
}
