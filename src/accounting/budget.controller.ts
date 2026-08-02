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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import type { AuthenticatedUser } from '../auth';
import { AccountTypeGuard, CurrentUser, RequireAccountType } from '../auth';
import type { Paginated } from '../common';
import { ApiDataResponse, ApiPaginatedResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { BudgetService } from './budget.service';
import {
  BudgetCardDto,
  BudgetDeletedDto,
  BudgetDto,
  BudgetsQueryDto,
  CreateBudgetDto,
  UpdateBudgetDto,
} from './dto';

/**
 * Бюджет центра (ТЗ 5.16: «Budget: план по категориям — allocated/spent,
 * период, статус», `GET/POST/PUT /accounting/budget`).
 *
 * Раздел Accounting доступен только позиции `Director` — правило Фазы 2
 * (`DIRECTOR_ONLY_SECTIONS`, сессия 0006).
 */
@ApiTags('Accounting')
@ApiBearerAuth('access-token')
@Controller('accounting/budget')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class BudgetController {
  constructor(private readonly budget: BudgetService) {}

  @Get()
  @RequirePermission('Permission.Accounting.Views')
  @ApiOperation({
    summary: 'Бюджеты',
    description:
      'Планы расходов с итогами «выделено / потрачено / остаток». `spent` **не хранится** — ' +
      'он считается по расходам за период плана, поэтому правка расхода задним числом сразу ' +
      'видна в бюджете. Период фильтра (`from`/`to`) отбирает планы, чей период ' +
      '**пересекается** с отрезком: вопрос «какие планы действуют в марте» не тот же, ' +
      'что «какие начались в марте».',
  })
  @ApiPaginatedResponse(BudgetDto, { description: 'Бюджеты с итогами' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: BudgetsQueryDto): Promise<Paginated<BudgetDto>> {
    return this.budget.findAll(query);
  }

  @Get(':id')
  @RequirePermission('Permission.Accounting.Views')
  @ApiOperation({
    summary: 'Карточка бюджета',
    description:
      'План со строками: по каждой статье — выделено, потрачено, остаток и освоение. ' +
      'План по разделу («Налоги») собирает расходы всех его подкатегорий. ' +
      'Отрицательный остаток — перерасход, это законный ответ: план ничего не запрещает.',
  })
  @ApiDataResponse(BudgetCardDto, { description: 'Бюджет со строками плана' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<BudgetCardDto> {
    return this.budget.findOne(id);
  }

  @Post()
  @RequirePermission('Permission.Accounting.ManageBudget')
  @ApiOperation({
    summary: 'Завести бюджет',
    description:
      'Период задаётся месяцами, обе границы включительно. Статьи плана должны быть ' +
      'действующими (422 на `INACTIVE`); раздел и его подкатегория в одном бюджете ' +
      'не соседствуют (422) — расход по подкатегории попал бы в обе строки. ' +
      'Периоды разных бюджетов пересекаться могут.',
  })
  @ApiDataResponse(BudgetCardDto, { status: HttpStatus.CREATED, description: 'Бюджет заведён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  create(
    @Body() dto: CreateBudgetDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BudgetCardDto> {
    return this.budget.create(dto, user.accountId);
  }

  @Put(':id')
  @RequirePermission('Permission.Accounting.ManageBudget')
  @ApiOperation({
    summary: 'Правка бюджета',
    description:
      '`lines` заменяет набор строк **целиком**; пустой массив очищает план, ' +
      'не переданное поле его не трогает. Закрытый (`CLOSED`) план не правится — ' +
      'у него принимается только возврат в `ACTIVE` отдельным запросом (422 на всё остальное).',
  })
  @ApiDataResponse(BudgetCardDto, { description: 'Обновлённый бюджет' })
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
    @Body() dto: UpdateBudgetDto,
  ): Promise<BudgetCardDto> {
    return this.budget.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('Permission.Accounting.ManageBudget')
  @ApiOperation({
    summary: 'Удаление бюджета',
    description:
      'Сверх перечня маршрутов ТЗ 5.16: без него ошибочный план остался бы в отчётах ' +
      'навсегда. Причина не требуется — в отличие от удаления расхода (там исчезает ' +
      'запись о деньгах, здесь — намерение их потратить). Закрытый план не удаляется (422).',
  })
  @ApiDataResponse(BudgetDeletedDto, { description: 'Бюджет удалён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<BudgetDeletedDto> {
    return this.budget.remove(id);
  }
}
