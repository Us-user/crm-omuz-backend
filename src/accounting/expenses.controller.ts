import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import type { AuthenticatedUser } from '../auth';
import { AccountTypeGuard, CurrentUser, RequireAccountType } from '../auth';
import type { Paginated } from '../common';
import { ApiDataResponse, ApiPaginatedResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import {
  CreateExpenseDto,
  ExpenseDeletedDto,
  ExpenseDto,
  ExpensesQueryDto,
  ExpensesTotalsDto,
  ReasonDto,
  UpdateExpenseDto,
} from './dto';
import { ExpensesService } from './expenses.service';

/**
 * Расходы центра (ТЗ 5.16: «Expenses», `GET/POST /accounting/expenses`).
 *
 * Раздел Accounting доступен только позиции `Director` — правило Фазы 2
 * (`DIRECTOR_ONLY_SECTIONS`, сессия 0006).
 */
@ApiTags('Accounting')
@ApiBearerAuth('access-token')
@Controller('accounting/expenses')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @RequirePermission('Permission.Accounting.Views')
  @ApiOperation({
    summary: 'Расходы',
    description:
      'Расходы центра за период (ТЗ 5.16). Период задаётся **месяцами** — как везде ' +
      'в отчётах проекта. Фильтр `categoryId` по категории верхнего уровня отбирает ' +
      'и её подкатегории: «Налоги» показывают НДС и подоходный. Сумма набора — ' +
      'в `meta.totals`, она одна на все страницы.',
  })
  @ApiExtraModels(ExpensesTotalsDto)
  @ApiPaginatedResponse(ExpenseDto, {
    description: 'Расходы; сумма — в `meta.totals`',
    meta: {
      totals: {
        $ref: getSchemaPath(ExpensesTotalsDto),
        description: 'Сумма расходов по всему отобранному набору.',
      },
    },
  })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: ExpensesQueryDto): Promise<Paginated<ExpenseDto>> {
    return this.expenses.findAll(query);
  }

  @Get(':id')
  @RequirePermission('Permission.Accounting.Views')
  @ApiOperation({ summary: 'Карточка расхода' })
  @ApiDataResponse(ExpenseDto, { description: 'Расход' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<ExpenseDto> {
    return this.expenses.findOne(id);
  }

  @Post()
  @RequirePermission('Permission.Accounting.ManageExpenses')
  @ApiOperation({
    summary: 'Провести расход',
    description:
      'Статья обязательна и должна быть действующей (422 на `INACTIVE`). `spentAt` — день, ' +
      'когда деньги ушли; по умолчанию сегодня. Филиал необязателен: аренда сервера ' +
      'и налоги общие для центра.',
  })
  @ApiDataResponse(ExpenseDto, { status: HttpStatus.CREATED, description: 'Расход проведён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  create(
    @Body() dto: CreateExpenseDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ExpenseDto> {
    return this.expenses.create(dto, user.accountId);
  }

  @Put(':id')
  @RequirePermission('Permission.Accounting.ManageExpenses')
  @ApiOperation({
    summary: 'Правка расхода',
    description: 'Пустой `branchId` делает расход общим для центра.',
  })
  @ApiDataResponse(ExpenseDto, { description: 'Обновлённый расход' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExpenseDto,
  ): Promise<ExpenseDto> {
    return this.expenses.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('Permission.Accounting.ManageExpenses')
  @ApiOperation({
    summary: 'Удаление расхода',
    description:
      'Сверх перечня маршрутов ТЗ 5.16 — как отмена платежа (0029): ошибочная строка иначе ' +
      'осталась бы в отчёте навсегда. Причина обязательна и уходит в лог.',
  })
  @ApiDataResponse(ExpenseDeletedDto, { description: 'Расход удалён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ): Promise<ExpenseDeletedDto> {
    return this.expenses.remove(id, dto);
  }
}
