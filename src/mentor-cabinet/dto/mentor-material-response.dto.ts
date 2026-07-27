import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus, LessonType, ResourceFileType, ResourceKind } from '@prisma/client';

import { MentorCourseGroupDto } from './mentor-course-response.dto';

/**
 * Материал урока (ТЗ 5.6: «Resource: Title/Type/ResourceFileType»).
 * Хранится **ссылка** на внешнее хранилище, а не файл (решение сессии 0009).
 */
export class MentorMaterialFileDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Слайды по хукам' })
  title!: string;

  @ApiProperty({ enum: ResourceKind, description: 'Зачем файл: раздел урока' })
  kind!: ResourceKind;

  @ApiProperty({ enum: ResourceFileType, description: 'Что это за файл: иконка и способ открытия' })
  fileType!: ResourceFileType;

  @ApiProperty({ example: 'https://drive.google.com/file/d/1abc/view' })
  url!: string;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;
}

/** Курс, к программе которого относится урок. */
export class MentorMaterialCourseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend' })
  title!: string;
}

/**
 * Урок, открытый одной из групп сотрудника (ТЗ 5.4, раздел «Material»).
 *
 * Это **не** вся программа курса: раздел показывает ровно то, что методист
 * открыл группам через «Show to group» (ТЗ 5.6) — ради этого мультивыбор
 * и существует. Материалы отдаются прямо в строке: в этом весь смысл раздела.
 */
export class MentorMaterialDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: MentorMaterialCourseDto })
  course!: MentorMaterialCourseDto;

  @ApiProperty({ example: 1, description: '«Day N» — номер учебного дня внутри курса' })
  dayNumber!: number;

  @ApiProperty({ example: 'Введение в React' })
  title!: string;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiProperty({ enum: LessonType })
  type!: LessonType;

  @ApiProperty({ enum: DirectoryStatus })
  status!: DirectoryStatus;

  @ApiProperty({
    type: [MentorCourseGroupDto],
    description: 'Кому из моих групп открыт урок; чужие группы сюда не попадают',
  })
  groups!: MentorCourseGroupDto[];

  @ApiProperty({ type: [MentorMaterialFileDto], description: 'Материалы урока (ссылки)' })
  files!: MentorMaterialFileDto[];
}
