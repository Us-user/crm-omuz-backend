import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsUUID } from 'class-validator';

import { MAX_ROLES_PER_REQUEST } from '../rbac.constants';

/**
 * Назначение или снятие ролей аккаунта (ТЗ 5.15: drawer «Add roles»).
 * За словом «роль» стоит позиция: права выдаются только позициями (ТЗ 3.2).
 */
export class AssignRolesDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'Идентификаторы позиций из справочника /api/v1/positions',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_ROLES_PER_REQUEST)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  positionIds!: string[];
}
