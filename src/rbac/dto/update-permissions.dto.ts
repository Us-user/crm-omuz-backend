import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayNotEmpty, ArrayMaxSize, IsArray, IsBoolean, ValidateNested } from 'class-validator';

import type { PermissionCode } from '../permission-catalog';
import { PERMISSION_CATALOG } from '../permission-catalog';
import { IsPermissionCode } from './permission-code.validator';

/** Одно переключение в каталоге прав. */
export class PermissionToggleDto {
  @ApiProperty({ example: 'Permission.Leads.Export' })
  @IsPermissionCode()
  code!: PermissionCode;

  @ApiProperty({ example: false })
  @IsBoolean()
  isEnabled!: boolean;
}

/**
 * Переключение прав каталога (ТЗ 5.15: «Permission — каталог прав (toggle)»).
 *
 * Пачкой, а не по одному праву: экран сохраняет раздел целиком, и построчные
 * запросы оставили бы каталог в промежуточном состоянии при обрыве связи.
 */
export class UpdatePermissionsDto {
  @ApiProperty({ type: [PermissionToggleDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(PERMISSION_CATALOG.length)
  @ValidateNested({ each: true })
  @Type(() => PermissionToggleDto)
  permissions!: PermissionToggleDto[];
}
