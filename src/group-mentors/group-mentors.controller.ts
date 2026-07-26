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
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import { AccountTypeGuard, RequireAccountType } from '../auth';
import type { Paginated } from '../common';
import { ApiDataResponse, ApiPaginatedResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import {
  AssignMentorDto,
  GroupMentorDto,
  GroupMentorQueryDto,
  GroupMentorRemovedDto,
  UpdateGroupMentorDto,
} from './dto';
import { GroupMentorsService } from './group-mentors.service';

/**
 * Менторы группы (ТЗ 5.5). Маршруты вложены в группу: назначение не существует
 * отдельно от неё, и адрес сам подтверждает, о какой группе речь.
 *
 * Просмотр закрыт правом на группы, изменения — отдельным `ManageMentors`:
 * видеть, кто ведёт группу, нужно всем, кто работает с группами, а назначать —
 * не всем.
 */
@ApiTags('Groups')
@ApiBearerAuth('access-token')
@Controller('groups/:groupId/mentors')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class GroupMentorsController {
  constructor(private readonly mentors: GroupMentorsService) {}

  @Get()
  @RequirePermission('Permission.Groups.Views')
  @ApiOperation({
    summary: 'Менторы группы',
    description:
      'Постраничный список с профилем каждого ментора. Фильтр `role` ' +
      '(Teaching/Support), поиск `search` — по имени, фамилии и телефону сотрудника.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiPaginatedResponse(GroupMentorDto, { description: 'Менторы группы' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findAll(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Query() query: GroupMentorQueryDto,
  ): Promise<Paginated<GroupMentorDto>> {
    return this.mentors.findAll(groupId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Groups.ManageMentors')
  @ApiOperation({
    summary: 'Назначение ментора группы',
    description:
      'Ментором может быть любой сотрудник в штате: отдельной позиции «Mentor» не требуется. ' +
      'Несуществующий или выведенный из штата сотрудник — 422, повторное назначение — 409 ' +
      '(роль меняется через `PUT`, а не вторым назначением).',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiDataResponse(GroupMentorDto, { description: 'Ментор назначен', status: HttpStatus.CREATED })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  assign(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() dto: AssignMentorDto,
  ): Promise<GroupMentorDto> {
    return this.mentors.assign(groupId, dto);
  }

  @Put(':employeeId')
  @RequirePermission('Permission.Groups.ManageMentors')
  @ApiOperation({
    summary: 'Смена роли ментора',
    description:
      'Перевод Teaching ↔ Support. Маршрута нет в перечне ТЗ 5.5, но без него роль ' +
      'менялась бы снятием и повторным назначением — двумя запросами, между которыми ' +
      'у группы нет преподавателя.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiParam({ name: 'employeeId', format: 'uuid', description: 'Профиль сотрудника-ментора' })
  @ApiDataResponse(GroupMentorDto, { description: 'Роль изменена' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  updateRole(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: UpdateGroupMentorDto,
  ): Promise<GroupMentorDto> {
    return this.mentors.updateRole(groupId, employeeId, dto);
  }

  @Delete(':employeeId')
  @RequirePermission('Permission.Groups.ManageMentors')
  @ApiOperation({
    summary: 'Снятие ментора с группы',
    description: 'Удаляется только назначение: профиль сотрудника остаётся нетронутым.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiParam({ name: 'employeeId', format: 'uuid' })
  @ApiDataResponse(GroupMentorRemovedDto, { description: 'Ментор снят с группы' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  remove(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ): Promise<GroupMentorRemovedDto> {
    return this.mentors.remove(groupId, employeeId);
  }
}
