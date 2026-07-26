import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus, DurationUnit } from '@prisma/client';

/** Курс каталога (ТЗ 5.6). */
export class CourseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend Basic' })
  title!: string;

  @ApiPropertyOptional({ nullable: true, example: 'HTML, CSS и вёрстка' })
  subtitle!: string | null;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiProperty({
    example: 1200,
    description:
      'Стоимость в сомони. Хранится как DECIMAL(12,2); в JSON отдаётся числом — ' +
      'два знака после запятой в этом диапазоне представимы точно.',
  })
  fee!: number;

  @ApiProperty({ example: false, description: '«Is last course» — триггер автовыпуска (ТЗ 5.11)' })
  isLastCourse!: boolean;

  @ApiPropertyOptional({ nullable: true, example: '#1E88E5' })
  colorPrimary!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '#0D47A1' })
  colorSecondary!: string | null;

  @ApiPropertyOptional({ nullable: true })
  logoUrl!: string | null;

  @ApiProperty({ example: 1 })
  durationValue!: number;

  @ApiProperty({ enum: DurationUnit })
  durationUnit!: DurationUnit;

  @ApiProperty({ enum: DirectoryStatus })
  status!: DirectoryStatus;

  @ApiProperty({ example: 3, description: '«Кол-во групп» с карточки курса (ТЗ 5.6)' })
  groupsCount!: number;

  @ApiProperty({ example: '2026-07-27T10:15:00.000Z' })
  createdAt!: string;
}

/** Ответ на удаление — чтобы интерфейс мог назвать удалённое. */
export class CourseDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend Basic' })
  title!: string;
}
