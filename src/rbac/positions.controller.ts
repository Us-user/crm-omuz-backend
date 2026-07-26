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
import { RequirePermission } from './decorators/require-permission.decorator';
import {
  CreatePositionDto,
  PositionDeletedDto,
  PositionDto,
  PositionListItemDto,
  PositionQueryDto,
  UpdatePositionDto,
} from './dto';
import { PositionsService } from './positions.service';

/**
 * Справочник позиций (ТЗ 5.14) — он же справочник ролей доступа из
 * `Administration → Users` (ТЗ 5.15). Каталог прав, из которого берутся
 * галочки, отдаёт `GET /api/v1/admin/permissions`.
 */
@ApiTags('Positions')
@ApiBearerAuth('access-token')
@Controller('positions')
// Класс целиком закрыт от студентов: справочник прав — не то, что им положено
// видеть (ТЗ 3.2). Конкретное действие проверяет право из каталога.
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class PositionsController {
  constructor(private readonly positions: PositionsService) {}

  @Get()
  @RequirePermission('Permission.Positions.Views')
  @ApiOperation({
    summary: 'Список позиций',
    description:
      'Постраничный справочник позиций с числом выданных прав и числом сотрудников. ' +
      'Поиск `search` — по названию и описанию. Требует права `Permission.Positions.Views`.',
  })
  @ApiPaginatedResponse(PositionListItemDto, { description: 'Позиции' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: PositionQueryDto): Promise<Paginated<PositionListItemDto>> {
    return this.positions.findAll(query);
  }

  @Get(':id')
  @RequirePermission('Permission.Positions.Views')
  @ApiOperation({
    summary: 'Карточка позиции с её правами',
    description: 'Позиция и коды прав, выданных ей из каталога (ТЗ 3.2).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PositionDto, { description: 'Позиция' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<PositionDto> {
    return this.positions.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Positions.Create')
  @ApiOperation({
    summary: 'Создание позиции',
    description:
      'Заводит позицию и сразу выдаёт ей права из каталога. Название уникально ' +
      'без учёта регистра. Права раздела Accounting доступны только позиции Director (ТЗ 3.2).',
  })
  @ApiDataResponse(PositionDto, { description: 'Позиция создана', status: HttpStatus.CREATED })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  create(@Body() dto: CreatePositionDto): Promise<PositionDto> {
    return this.positions.create(dto);
  }

  @Put(':id')
  @RequirePermission('Permission.Positions.Update')
  @ApiOperation({
    summary: 'Правка позиции и её прав',
    description:
      'Переданный `permissions` заменяет набор галочек целиком. Системную позицию ' +
      'Director изменить нельзя (422): она всегда держит весь каталог прав.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PositionDto, { description: 'Позиция изменена' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePositionDto,
  ): Promise<PositionDto> {
    return this.positions.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('Permission.Positions.Delete')
  @ApiOperation({
    summary: 'Удаление позиции',
    description:
      'Отказ, если позицию занимают сотрудники (409) или если она системная (422). ' +
      'Права позиции уходят вместе с ней.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(PositionDeletedDto, { description: 'Позиция удалена' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<PositionDeletedDto> {
    return this.positions.remove(id);
  }
}
