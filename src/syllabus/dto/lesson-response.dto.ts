import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus, LessonType } from '@prisma/client';

/** Группа из мультивыбора «Show to group» — коротко, чтобы экран не догружал названия. */
export class LessonGroupDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend-1' })
  name!: string;
}

/** Урок программы курса (ТЗ 5.6). */
export class LessonDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', description: 'Курс, чья это программа' })
  courseId!: string;

  @ApiProperty({ example: 1, description: '«Day N» из ТЗ 5.6' })
  dayNumber!: number;

  @ApiProperty({ example: 'Вёрстка: блочная модель' })
  title!: string;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiProperty({ enum: LessonType })
  type!: LessonType;

  @ApiProperty({ enum: DirectoryStatus })
  status!: DirectoryStatus;

  @ApiProperty({
    type: [LessonGroupDto],
    description: '«Show to group» — группы, которым урок открыт',
  })
  visibleToGroups!: LessonGroupDto[];

  @ApiProperty({
    example: 3,
    description: 'Сколько материалов у урока. Сами файлы — в `/lessons/{lessonId}/files`.',
  })
  filesCount!: number;

  @ApiProperty({ example: '2026-07-27T10:15:00.000Z' })
  createdAt!: string;
}

/** Ответ на удаление — чтобы интерфейс мог назвать удалённое. */
export class LessonDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 1 })
  dayNumber!: number;

  @ApiProperty({ example: 'Вёрстка: блочная модель' })
  title!: string;
}
