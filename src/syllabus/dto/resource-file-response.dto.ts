import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceFileType, ResourceKind } from '@prisma/client';

/** Материал урока (ТЗ 5.6). */
export class ResourceFileDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', description: 'Урок, к которому прикреплён материал' })
  lessonId!: string;

  @ApiProperty({ example: 'Лекция 1. Блочная модель' })
  title!: string;

  @ApiProperty({ enum: ResourceKind, description: 'Зачем материал (ТЗ 5.6)' })
  kind!: ResourceKind;

  @ApiProperty({ enum: ResourceFileType, description: 'Что это за файл (ТЗ 5.6)' })
  fileType!: ResourceFileType;

  @ApiProperty({ example: 'https://cdn.omuz.tj/courses/frontend/day-1.pdf' })
  url!: string;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiProperty({ example: '2026-07-27T10:15:00.000Z' })
  createdAt!: string;
}

/** Ответ на удаление — чтобы интерфейс мог назвать удалённое. */
export class ResourceFileDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Лекция 1. Блочная модель' })
  title!: string;
}
