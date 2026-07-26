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
