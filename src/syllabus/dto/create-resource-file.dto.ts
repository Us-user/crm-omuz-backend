import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceFileType, ResourceKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

import { trimString } from '../../common';

/**
 * Добавление материала к уроку (ТЗ 5.6: «Resource: Title/Type/ResourceFileType»).
 *
 * Хранится ссылка на внешнее хранилище, а не сам файл (решение сессии 0009).
 */
export class CreateResourceFileDto {
  @ApiProperty({ example: 'Лекция 1. Блочная модель', minLength: 2, maxLength: 200 })
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({
    enum: ResourceKind,
    default: ResourceKind.LECTURE,
    description: 'Зачем материал: Lecture / Practice / Homework (ТЗ 5.6)',
  })
  @IsOptional()
  @IsEnum(ResourceKind)
  kind?: ResourceKind;

  @ApiPropertyOptional({
    enum: ResourceFileType,
    default: ResourceFileType.OTHER,
    description: '`ResourceFileType` из ТЗ 5.6 — что это за файл (иконка и способ открытия)',
  })
  @IsOptional()
  @IsEnum(ResourceFileType)
  fileType?: ResourceFileType;

  @ApiProperty({
    example: 'https://cdn.omuz.tj/courses/frontend/day-1.pdf',
    maxLength: 1000,
    description: 'Ссылка на файл во внешнем хранилище',
  })
  @Transform(trimString)
  @IsString()
  @MaxLength(1000)
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  url!: string;

  @ApiPropertyOptional({ maxLength: 2000, description: 'Пустая строка очищает поле.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(2000)
  description?: string;
}
