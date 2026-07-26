import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import type { PermissionSection } from '../permission-catalog';
import { PERMISSION_SECTION_TITLES } from '../permission-catalog';

/** Разделы каталога — их немного, поэтому список допустимых значений уместен и в Swagger. */
const SECTIONS = Object.keys(PERMISSION_SECTION_TITLES) as PermissionSection[];

/**
 * Фильтр каталога прав. Пагинации нет намеренно (см. `PermissionCatalogDto`):
 * экран настроек рисует переключатели по разделам, и раздел нужен целиком.
 */
export class PermissionCatalogQueryDto {
  @ApiPropertyOptional({
    enum: SECTIONS,
    description: 'Оставить в выдаче только один раздел каталога',
  })
  @IsOptional()
  @IsIn(SECTIONS)
  section?: PermissionSection;
}
