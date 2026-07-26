import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { trimString } from '../../common';
import type { PermissionCode } from '../permission-catalog';
import { PERMISSION_CATALOG } from '../permission-catalog';
import { IsPermissionCode } from './permission-code.validator';

/**
 * Создание позиции (ТЗ 5.14: «Позиции (Position) — CRUD-справочник; назначение
 * прав из каталога Permissions»). Позиция здесь же и есть роль доступа (ТЗ 5.15).
 */
export class CreatePositionDto {
  @ApiProperty({
    example: 'Accountant',
    minLength: 2,
    maxLength: 60,
    description: 'Название позиции. Уникально без учёта регистра.',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  @ApiPropertyOptional({
    example: 'Ведёт оплаты студентов и расходы центра',
    maxLength: 300,
    description: 'Описание. Пустая строка очищает поле.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['Permission.Students.Views', 'Permission.Groups.Views'],
    description:
      'Права позиции — «галочки» из каталога (ТЗ 3.2). Полный список кодов: ' +
      'GET /api/v1/admin/permissions. Раздел Accounting доступен только позиции Director.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PERMISSION_CATALOG.length)
  @ArrayUnique()
  // Значения проверены валидатором, поэтому тип сужен до кодов каталога:
  // сервис работает с ними как с `PermissionCode`, а не с произвольными строками.
  @IsPermissionCode({ each: true })
  permissions?: PermissionCode[];
}
