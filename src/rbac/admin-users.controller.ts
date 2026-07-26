import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import { AccountTypeGuard, RequireAccountType } from '../auth';
import type { Paginated } from '../common';
import { ApiDataResponse, ApiPaginatedResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from './decorators/require-permission.decorator';
import { AdminUserDto, AdminUserQueryDto, AssignRolesDto, UserRolesDto } from './dto';
import { AdminUsersService } from './admin-users.service';
import { DIRECTOR_POSITION_NAME } from './rbac.constants';

/**
 * `Administration → Users` (ТЗ 5.15): список всех аккаунтов и drawer «Add roles».
 *
 * `{id}` в пути — идентификатор **аккаунта** (список отдаёт именно аккаунты),
 * а роли ложатся на связанный профиль сотрудника.
 */
@ApiTags('Administration')
@ApiBearerAuth('access-token')
@Controller('admin/users')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @RequirePermission('Permission.Administration.ViewUsers')
  @ApiOperation({
    summary: 'Список аккаунтов с их ролями',
    description:
      'Type / Roles / Phone по ТЗ 5.15. Фильтры `type` и `status`, поиск `search` — ' +
      'по телефону, email и имени профиля. Требует права `Permission.Administration.ViewUsers`.',
  })
  @ApiPaginatedResponse(AdminUserDto, { description: 'Аккаунты' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: AdminUserQueryDto): Promise<Paginated<AdminUserDto>> {
    return this.users.findAll(query);
  }

  @Post(':id/roles')
  // 200, а не дефолтный для POST 201: ресурс не создаётся, а возвращается набор
  // ролей аккаунта — повторный запрос с тем же телом ничего не добавляет.
  @HttpCode(HttpStatus.OK)
  @RequirePermission('Permission.Administration.ManageUserRoles')
  @ApiOperation({
    summary: 'Назначение ролей аккаунту',
    description:
      'Добавляет позиции сотруднику; уже назначенные пропускаются. Права сотрудника — ' +
      'объединение прав всех его позиций (ТЗ 3.2) и начинают действовать сразу, ' +
      'без повторного входа. Аккаунту студента роли не назначаются (422).',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Идентификатор аккаунта' })
  @ApiDataResponse(UserRolesDto, { description: 'Роли аккаунта после назначения' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  assignRoles(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignRolesDto,
  ): Promise<UserRolesDto> {
    return this.users.assignRoles(id, dto);
  }

  // Тело у DELETE — сознательно: ТЗ 5.15 задаёт пару `POST/DELETE /admin/users/{id}/roles`,
  // и снятие нескольких ролей одним запросом просит тот же список, что и назначение.
  @Delete(':id/roles')
  @RequirePermission('Permission.Administration.ManageUserRoles')
  @ApiOperation({
    summary: 'Снятие ролей с аккаунта',
    description:
      'Снимает перечисленные позиции; отсутствующие игнорируются. Права пропадают сразу. ' +
      `Последнего руководителя (${DIRECTOR_POSITION_NAME}) разжаловать нельзя (422).`,
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Идентификатор аккаунта' })
  @ApiDataResponse(UserRolesDto, { description: 'Роли аккаунта после снятия' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  removeRoles(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignRolesDto,
  ): Promise<UserRolesDto> {
    return this.users.removeRoles(id, dto);
  }
}
