import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Право каталога с состоянием переключателя (ТЗ 5.15). */
export class PermissionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Permission.Students.Views' })
  code!: string;

  @ApiProperty({ example: 'Students' })
  section!: string;

  @ApiProperty({ example: 'Views' })
  action!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Просмотр списка и карточек студентов' })
  description!: string | null;

  @ApiProperty({
    example: true,
    description: 'Выключенное право не действует ни для одной позиции',
  })
  isEnabled!: boolean;

  @ApiProperty({
    example: false,
    description: 'Служебное право: выключить нельзя, иначе управление правами не вернуть',
  })
  isSystem!: boolean;
}

/** Раздел каталога — в этих группах экран рисует переключатели. */
export class PermissionSectionDto {
  @ApiProperty({ example: 'Students' })
  section!: string;

  @ApiProperty({ example: 'Студенты' })
  title!: string;

  @ApiProperty({ type: [PermissionDto] })
  permissions!: PermissionDto[];
}

/**
 * Каталог прав целиком, по разделам.
 *
 * Не постраничный список: экран `Administration → Permission` — это настройки,
 * где переключатели сгруппированы по разделам. Страница из 20 галочек, срезанная
 * посередине раздела, не была бы пригодна для работы.
 */
export class PermissionCatalogDto {
  @ApiProperty({ example: 99, description: 'Сколько прав в выдаче' })
  total!: number;

  @ApiProperty({ type: [PermissionSectionDto] })
  sections!: PermissionSectionDto[];
}
