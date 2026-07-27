import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ActivityCategory } from '../../performance/performance';

/** Кто именно в рейтинге — столько, сколько нужно строке списка. */
export class LeaderStudentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Нигина' })
  firstName!: string;

  @ApiProperty({ example: 'Каримова' })
  lastName!: string;

  @ApiPropertyOptional({ nullable: true, example: 'https://cdn.omuz.tj/students/1.jpg' })
  photoUrl!: string | null;
}

/** Где студент учится сейчас — чтобы строка рейтинга не требовала второго запроса. */
export class LeaderGroupDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend-1' })
  name!: string;

  @ApiProperty({ format: 'uuid' })
  courseId!: string;

  @ApiProperty({ example: 'Frontend Basic' })
  courseTitle!: string;
}

/** Строка рейтинга (ТЗ 5.13). */
export class LeaderDto {
  @ApiProperty({
    example: 1,
    description:
      '№ в рейтинге, с 1. При равенстве баллов место одно на всех, поэтому номера ' +
      'идут с пропусками: 1, 1, 3.',
  })
  position!: number;

  @ApiProperty({
    example: true,
    description:
      'Корона (ТЗ 5.3): №1 **текущей выборки**. При фильтре по группе или курсу это ' +
      'лидер среза, а не центра. При равенстве баллов корона у всех первых.',
  })
  isTopStudent!: boolean;

  @ApiProperty({ type: LeaderStudentDto })
  student!: LeaderStudentDto;

  @ApiProperty({
    example: 96.5,
    description: 'Средний Sum по финализированным неделям, округлённый до двух знаков.',
  })
  averageScore!: number;

  @ApiProperty({ enum: ActivityCategory, description: 'Категория активности (ТЗ 5.5).' })
  category!: ActivityCategory;

  @ApiProperty({ example: 'ChatGPT' })
  categoryTitle!: string;

  @ApiProperty({ example: 4, description: 'Сколько закрытых недель учтено в балле.' })
  weeksCount!: number;

  @ApiProperty({
    type: [LeaderGroupDto],
    description: 'Действующие членства студента: где он учится сейчас.',
  })
  groups!: LeaderGroupDto[];
}

/** Кто закрыл месяц. `null` — профиль сотрудника удалён (`SET NULL`). */
export class MonthClosedByDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Фаррух' })
  firstName!: string;

  @ApiProperty({ example: 'Раҳимов' })
  lastName!: string;
}

/** Строка снимка месяца (ТЗ 5.13: «Winners of the last month»). */
export class MonthlyWinnerDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 1, description: 'Место в месяце. При ничьей одно на всех.' })
  place!: number;

  @ApiProperty({ type: LeaderStudentDto })
  student!: LeaderStudentDto;

  @ApiProperty({
    example: 98.75,
    description:
      'Средний Sum по финализированным неделям **этого месяца** на момент закрытия. ' +
      'Число сохранено, а не пересчитывается: снимок не должен меняться от правки журнала.',
  })
  averageScore!: number;

  @ApiProperty({ example: 4, description: 'Сколько недель месяца учтено.' })
  weeksCount!: number;

  @ApiProperty({ enum: ActivityCategory, description: 'Категория, выведенная из балла месяца.' })
  category!: ActivityCategory;

  @ApiProperty({ example: 'ChatGPT' })
  categoryTitle!: string;
}

/** Снимок месяца целиком. */
export class MonthWinnersDto {
  @ApiPropertyOptional({
    nullable: true,
    example: '2026-06',
    description: 'Месяц снимка. `null` — в системе не закрыт ещё ни один месяц.',
  })
  month!: string | null;

  @ApiProperty({
    example: true,
    description: 'Закрыт ли месяц. `false` — снимка нет, и список победителей пуст.',
  })
  closed!: boolean;

  @ApiPropertyOptional({ nullable: true, example: '2026-07-01T09:00:00.000Z' })
  closedAt!: string | null;

  @ApiPropertyOptional({ type: MonthClosedByDto, nullable: true })
  closedBy!: MonthClosedByDto | null;

  @ApiProperty({ type: [MonthlyWinnerDto], description: 'Победители по местам, с первого.' })
  winners!: MonthlyWinnerDto[];
}

/** Итог снятия снимка месяца. */
export class MonthWinnersRemovedDto {
  @ApiProperty({ example: '2026-06' })
  month!: string;

  @ApiProperty({ example: 3, description: 'Сколько строк снимка убрано.' })
  removed!: number;
}
