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
import { CreateRoomDto, RoomDeletedDto, RoomDto, RoomQueryDto, UpdateRoomDto } from './dto';
import { RoomsService } from './rooms.service';

/**
 * Аудитории (ТЗ 5.10). Отсюда берётся поле «Room» в расписании занятий,
 * которое соберётся в Фазе 10.
 */
@ApiTags('Rooms')
@ApiBearerAuth('access-token')
@Controller('rooms')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get()
  @RequirePermission('Permission.Rooms.Views')
  @ApiOperation({
    summary: 'Список аудиторий',
    description:
      'Постраничный список с филиалом каждой аудитории. Фильтры `branchId` и `status`, ' +
      'поиск `search` — по названию, описанию и названию филиала.',
  })
  @ApiPaginatedResponse(RoomDto, { description: 'Аудитории' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: RoomQueryDto): Promise<Paginated<RoomDto>> {
    return this.rooms.findAll(query);
  }

  @Get(':id')
  @RequirePermission('Permission.Rooms.Views')
  @ApiOperation({ summary: 'Карточка аудитории' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(RoomDto, { description: 'Аудитория' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<RoomDto> {
    return this.rooms.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Rooms.Create')
  @ApiOperation({
    summary: 'Создание аудитории',
    description:
      'Название уникально внутри филиала, без учёта регистра (409). ' +
      'Несуществующий `branchId` — 422: ресурс из пути найден, не найдено то, что в теле.',
  })
  @ApiDataResponse(RoomDto, { description: 'Аудитория создана', status: HttpStatus.CREATED })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  create(@Body() dto: CreateRoomDto): Promise<RoomDto> {
    return this.rooms.create(dto);
  }

  @Put(':id')
  @RequirePermission('Permission.Rooms.Update')
  @ApiOperation({
    summary: 'Правка аудитории',
    description:
      'Аудиторию можно перенести в другой филиал — тёзка проверяется в филиале назначения.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(RoomDto, { description: 'Аудитория изменена' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoomDto): Promise<RoomDto> {
    return this.rooms.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('Permission.Rooms.Delete')
  @ApiOperation({ summary: 'Удаление аудитории' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(RoomDeletedDto, { description: 'Аудитория удалена' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<RoomDeletedDto> {
    return this.rooms.remove(id);
  }
}
