import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Позиция в списке справочника (ТЗ 5.14). */
export class PositionListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Manager' })
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiProperty({
    example: false,
    description: 'Системная позиция (Director): изменять и удалять нельзя',
  })
  isSystem!: boolean;

  @ApiProperty({ example: 12, description: 'Сколько прав выдано позиции' })
  permissionsCount!: number;

  @ApiProperty({ example: 3, description: 'Сколько сотрудников занимают позицию' })
  employeesCount!: number;

  @ApiProperty({ example: '2026-07-26T10:15:00.000Z' })
  createdAt!: string;
}

/** Карточка позиции: то же плюс сами галочки прав. */
export class PositionDto extends PositionListItemDto {
  @ApiProperty({
    type: [String],
    example: ['Permission.Students.Views', 'Permission.Groups.Views'],
    description: 'Коды прав позиции из каталога (ТЗ 3.2)',
  })
  permissions!: string[];
}

/** Ответ на удаление позиции — чтобы интерфейс мог назвать удалённое. */
export class PositionDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Manager' })
  name!: string;
}
