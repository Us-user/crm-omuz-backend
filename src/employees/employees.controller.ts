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

import type { AuthenticatedUser } from '../auth';
import { AccountTypeGuard, CurrentUser, RequireAccountType } from '../auth';
import type { Paginated } from '../common';
import { ApiDataResponse, ApiPaginatedResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import {
  CreateEmployeeDto,
  EmployeeDeletedDto,
  EmployeeDto,
  EmployeeQueryDto,
  UpdateEmployeeDto,
} from './dto';
import { EmployeesService } from './employees.service';

/**
 * Сотрудники (ТЗ 5.14) — список, карточка «Employer» и форма.
 *
 * Класс закрыт по типу аккаунта целиком: персонал центра — не то, что положено
 * видеть студенту (ТЗ 3.2 — ему доступен просмотр только своих данных).
 * Конкретное действие сверх этого закрыто своим правом каталога (ТЗ 3.8).
 *
 * Позиции сотрудника принимаются формой (ТЗ 5.14: «Position — мультивыбор»),
 * но требуют **второго** права — `Permission.Administration.ManageUserRoles`:
 * позиция это роль доступа (ТЗ 3.2), и правка карточки не должна быть способом
 * выдать себе `Director`. Проверка идёт в сервисе, а не декоратором, потому что
 * зависит от того, передано ли поле: форма без мультивыбора — обычная правка.
 */
@ApiTags('Employees')
@ApiBearerAuth('access-token')
@Controller('employees')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @RequirePermission('Permission.Employees.Views')
  @ApiOperation({
    summary: 'Список сотрудников',
    description:
      'Постраничный список с филиалом, аккаунтом, позициями и группами каждого сотрудника ' +
      '(ТЗ 5.14). Фильтры: `status`, `branchId` (ТЗ 3.3), `positionId` и `hasAccount`. ' +
      'Фильтр по позиции и есть список менторов (ТЗ 5.4): ментор — это сотрудник ' +
      'с соответствующей позицией, а не отдельная сущность. Поиск `search` — по имени, ' +
      'фамилии, отчеству, телефону и email.',
  })
  @ApiPaginatedResponse(EmployeeDto, { description: 'Сотрудники' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: EmployeeQueryDto): Promise<Paginated<EmployeeDto>> {
    return this.employees.findAll(query);
  }

  @Get(':id')
  @RequirePermission('Permission.Employees.Views')
  @ApiOperation({ summary: 'Карточка сотрудника' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(EmployeeDto, { description: 'Карточка сотрудника' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<EmployeeDto> {
    return this.employees.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Employees.Create')
  @ApiOperation({
    summary: 'Создание сотрудника',
    description:
      'Заводит профиль без логина: аккаунт по ТЗ 5.14 опционален и появляется переводом ' +
      'студента (ТЗ 3.1) либо сид-скриптом. Телефон приводится к E.164 и уникален среди ' +
      'сотрудников (409), несуществующий филиал или позиция в теле — 422. ' +
      '`positionIds` дополнительно требуют права `Permission.Administration.ManageUserRoles` (403).',
  })
  @ApiDataResponse(EmployeeDto, { description: 'Сотрудник создан', status: HttpStatus.CREATED })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  create(
    @Body() dto: CreateEmployeeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EmployeeDto> {
    return this.employees.create(dto, user.accountId);
  }

  @Put(':id')
  @RequirePermission('Permission.Employees.Update')
  @ApiOperation({
    summary: 'Правка карточки сотрудника',
    description:
      'Не переданное поле остаётся прежним, пустая строка в необязательном поле очищает его. ' +
      '`positionIds` заменяют набор позиций целиком (пустой массив снимает все) и требуют ' +
      'права `Permission.Administration.ManageUserRoles`. ' +
      '**Перевод в `INACTIVE` закрывает вход:** аккаунт блокируется той же транзакцией, ' +
      'а сессии гасятся; возврат в `ACTIVE` вход открывает. Последнего действующего ' +
      '`Director` нельзя ни разжаловать, ни вывести из штата (422).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(EmployeeDto, { description: 'Карточка изменена' })
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
    @Body() dto: UpdateEmployeeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EmployeeDto> {
    return this.employees.update(id, dto, user.accountId);
  }

  @Delete(':id')
  @RequirePermission('Permission.Employees.Delete')
  @ApiOperation({
    summary: 'Удаление сотрудника',
    description:
      'Только «чистого» профиля: сотрудник, который ведёт группы, закрывал недели журнала, ' +
      'писал заметки или начислял коины, не удаляется (409) — вместе с ним эти записи ' +
      'остались бы без автора. Для «человек больше не работает» есть статус «INACTIVE», ' +
      'он же закрывает вход. Последнего действующего `Director` удалить нельзя (422). ' +
      'Аккаунт сотрудника удаляется вместе с профилем: логин без профиля запрещён ТЗ 3.1.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(EmployeeDeletedDto, { description: 'Сотрудник удалён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<EmployeeDeletedDto> {
    return this.employees.remove(id);
  }
}
