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
import { CreateGroupDto, GroupDeletedDto, GroupDto, GroupQueryDto, UpdateGroupDto } from './dto';
import { GroupsService } from './groups.service';

/**
 * Учебные группы (ТЗ 5.5). Менторы группы живут отдельным модулем
 * (`GroupMentorsController`, `/groups/{groupId}/mentors`); расписание и состав
 * студентов — отдельные маршруты той же фазы, они добавятся следующими кусками.
 */
@ApiTags('Groups')
@ApiBearerAuth('access-token')
@Controller('groups')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  @RequirePermission('Permission.Groups.Views')
  @ApiOperation({
    summary: 'Список групп',
    description:
      'Постраничный список с курсом и филиалом каждой группы. Фильтры `branchId`, ' +
      '`courseId`, `status` и `format` (ТЗ 5.5), поиск `search` — по названию и описанию ' +
      'группы, названию курса и названию филиала.',
  })
  @ApiPaginatedResponse(GroupDto, { description: 'Группы' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: GroupQueryDto): Promise<Paginated<GroupDto>> {
    return this.groups.findAll(query);
  }

  @Get(':id')
  @RequirePermission('Permission.Groups.Views')
  @ApiOperation({ summary: 'Карточка группы' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(GroupDto, { description: 'Группа' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<GroupDto> {
    return this.groups.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Groups.Create')
  @ApiOperation({
    summary: 'Создание группы',
    description:
      'Курс и филиал обязательны; несуществующий `courseId` или `branchId` — 422 ' +
      '(ресурс из пути найден, не найдено то, что в теле). Название уникально ' +
      'внутри филиала, без учёта регистра (409).',
  })
  @ApiDataResponse(GroupDto, { description: 'Группа создана', status: HttpStatus.CREATED })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  create(@Body() dto: CreateGroupDto): Promise<GroupDto> {
    return this.groups.create(dto);
  }

  @Put(':id')
  @RequirePermission('Permission.Groups.Update')
  @ApiOperation({
    summary: 'Правка группы',
    description:
      'Группу можно перенести в другой филиал (тёзка проверяется в филиале назначения) ' +
      'и перевести на другой курс. Пустая строка очищает необязательное поле, включая даты.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(GroupDto, { description: 'Группа изменена' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateGroupDto): Promise<GroupDto> {
    return this.groups.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('Permission.Groups.Delete')
  @ApiOperation({ summary: 'Удаление группы' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(GroupDeletedDto, { description: 'Группа удалена' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<GroupDeletedDto> {
    return this.groups.remove(id);
  }
}
