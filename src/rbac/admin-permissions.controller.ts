import { Body, Controller, Get, HttpStatus, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import { AccountTypeGuard, RequireAccountType } from '../auth';
import { ApiDataResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from './decorators/require-permission.decorator';
import { PermissionCatalogAdminService } from './permission-catalog-admin.service';
import { PermissionCatalogDto, PermissionCatalogQueryDto, UpdatePermissionsDto } from './dto';

/**
 * `Administration → Permission` (ТЗ 5.15): каталог прав и его переключатель.
 *
 * Этот же список кодов используется как источник галочек для позиций
 * (`POST/PUT /api/v1/positions`).
 */
@ApiTags('Administration')
@ApiBearerAuth('access-token')
@Controller('admin/permissions')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class AdminPermissionsController {
  constructor(private readonly catalog: PermissionCatalogAdminService) {}

  @Get()
  @RequirePermission('Permission.Administration.ViewPermissions')
  @ApiOperation({
    summary: 'Каталог прав по разделам',
    description:
      'Все права системы в нотации `Permission.<Раздел>.<Действие>` (ТЗ 3.2) ' +
      'с состоянием переключателя. Ответ не постраничный: это экран настроек, ' +
      'где раздел нужен целиком (`section` оставляет один раздел).',
  })
  @ApiDataResponse(PermissionCatalogDto, { description: 'Каталог прав' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  getCatalog(@Query() query: PermissionCatalogQueryDto): Promise<PermissionCatalogDto> {
    return this.catalog.getCatalog(query.section);
  }

  @Put()
  @RequirePermission('Permission.Administration.ManagePermissions')
  @ApiOperation({
    summary: 'Переключение прав каталога',
    description:
      'Выключенное право не действует ни для одной позиции и перестаёт работать сразу: ' +
      'guard читает права из БД на каждый запрос. Служебные права ' +
      '(`Permission.Administration.ViewPermissions` и `...ManagePermissions`) ' +
      'выключить нельзя — иначе управление правами нельзя было бы вернуть через API. ' +
      'В ответ приходит каталог целиком.',
  })
  @ApiDataResponse(PermissionCatalogDto, { description: 'Каталог прав после изменения' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  update(@Body() dto: UpdatePermissionsDto): Promise<PermissionCatalogDto> {
    return this.catalog.update(dto);
  }
}
