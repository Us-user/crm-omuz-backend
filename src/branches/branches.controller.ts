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
// Прямой путь, а не barrel `../rbac`: тот реэкспортирует ещё и сервисы
// с репозиториями, а контроллеру нужен только декоратор.
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { BranchesService } from './branches.service';
import {
  BranchDeletedDto,
  BranchDto,
  BranchQueryDto,
  CreateBranchDto,
  UpdateBranchDto,
} from './dto';

/** Филиалы центра (ТЗ 5.17). Мультифилиальность сквозная — см. ТЗ 3.3. */
@ApiTags('Branches')
@ApiBearerAuth('access-token')
@Controller('branches')
// Справочники учебного контура ведут сотрудники; студенту положен только
// просмотр своих данных (ТЗ 3.2). Конкретное действие проверяет право каталога.
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  @RequirePermission('Permission.Branches.Views')
  @ApiOperation({
    summary: 'Список филиалов',
    description:
      'Постраничный список со счётчиками аудиторий, студентов и сотрудников — по ним ' +
      'строится график студентов по филиалам (ТЗ 5.17). Поиск `search` — по названию, ' +
      'городу, району и адресу.',
  })
  @ApiPaginatedResponse(BranchDto, { description: 'Филиалы' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: BranchQueryDto): Promise<Paginated<BranchDto>> {
    return this.branches.findAll(query);
  }

  @Get(':id')
  @RequirePermission('Permission.Branches.Views')
  @ApiOperation({ summary: 'Карточка филиала' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(BranchDto, { description: 'Филиал' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<BranchDto> {
    return this.branches.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Branches.Create')
  @ApiOperation({
    summary: 'Создание филиала',
    description: 'Название уникально без учёта регистра; телефон приводится к E.164.',
  })
  @ApiDataResponse(BranchDto, { description: 'Филиал создан', status: HttpStatus.CREATED })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
  )
  create(@Body() dto: CreateBranchDto): Promise<BranchDto> {
    return this.branches.create(dto);
  }

  @Put(':id')
  @RequirePermission('Permission.Branches.Update')
  @ApiOperation({
    summary: 'Правка филиала',
    description:
      'Не переданное поле остаётся прежним; пустая строка в необязательном поле ' +
      '(район, телефон, описание) очищает его.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(BranchDto, { description: 'Филиал изменён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBranchDto): Promise<BranchDto> {
    return this.branches.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('Permission.Branches.Delete')
  @ApiOperation({
    summary: 'Удаление филиала',
    description:
      'Отказ (409), если к филиалу привязаны аудитории, студенты или сотрудники. ' +
      'Чтобы вывести филиал из работы, не теряя историю, переведите его в статус INACTIVE.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(BranchDeletedDto, { description: 'Филиал удалён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<BranchDeletedDto> {
    return this.branches.remove(id);
  }
}
