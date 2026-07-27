import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus, DurationUnit } from '@prisma/client';

/** Своя группа, которая учится по этому курсу. */
export class MentorCourseGroupDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend-1' })
  name!: string;
}

/**
 * Курс, по которому сотрудник ведёт хотя бы одну группу (ТЗ 5.4, раздел «Courses»).
 *
 * Стоимости курса (`fee`, ТЗ 5.6) здесь нет: раздел отвечает на вопрос «что
 * я преподаю», а цена относится к бухгалтерии (ТЗ 5.16), доступ к которой
 * даётся правами. Кабинет прав не спрашивает — и потому не показывает того,
 * на что права нужны.
 */
export class MentorCourseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend' })
  title!: string;

  @ApiPropertyOptional({ nullable: true, example: 'React и TypeScript' })
  subtitle!: string | null;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '#1E88E5' })
  colorPrimary!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '#90CAF9' })
  colorSecondary!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'https://cdn.omuz.tj/courses/frontend.png' })
  logoUrl!: string | null;

  @ApiProperty({ example: 3, description: 'Длительность: число (единица — в `durationUnit`)' })
  durationValue!: number;

  @ApiProperty({ enum: DurationUnit })
  durationUnit!: DurationUnit;

  @ApiProperty({
    example: false,
    description: '«Is last course» (ТЗ 5.6): завершение группы такого курса запускает автовыпуск',
  })
  isLastCourse!: boolean;

  @ApiProperty({ enum: DirectoryStatus })
  status!: DirectoryStatus;

  @ApiProperty({
    type: [MentorCourseGroupDto],
    description: 'Свои группы этого курса — только те, где сотрудник числится ментором',
  })
  groups!: MentorCourseGroupDto[];
}
