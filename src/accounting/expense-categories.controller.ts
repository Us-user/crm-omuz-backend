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

import { AccountTypeGuard, RequireAccountType } from '../auth';
import { ApiDataResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import {
  CreateExpenseCategoryDto,
  ExpenseCategoriesQueryDto,
  ExpenseCategoryCatalogDto,
  ExpenseCategoryDeletedDto,
  ExpenseCategoryDto,
  UpdateExpenseCategoryDto,
} from './dto';
import { ExpenseCategoriesService } from './expense-categories.service';

/**
 * Справочник статей расхода (ТЗ 5.16: «Expenses: категории»).
 *
 * Весь раздел Accounting доступен только позиции `Director` — это правило
 * Фазы 2 (`DIRECTOR_ONLY_SECTIONS`, сессия 0006), поэтому здесь достаточно
 * обычной проверки права.
 */
@ApiTags('Accounting')
@ApiBearerAuth('access-token')
@Controller('accounting/expense-categories')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class ExpenseCategoriesController {
  constructor(private readonly categories: ExpenseCategoriesService) {}

  @Get()
  @RequirePermission('Permission.Accounting.Views')
  @ApiOperation({
    summary: 'Категории расходов',
    description:
      'Двухуровневый справочник статей (ТЗ 5.16: Tax→Income tax/VAT/Property/Social, Office, ' +
      'Marketing, Employees). Выдача **не постраничная**, а деревом: страница отрезала бы ' +
      'подкатегории от родителя. `search` ищет по названию и описанию и оставляет ветку целой.',
  })
  @ApiDataResponse(ExpenseCategoryCatalogDto, { description: 'Справочник категорий' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: ExpenseCategoriesQueryDto): Promise<ExpenseCategoryCatalogDto> {
    return this.categories.findAll(query);
  }

  @Get(':id')
  @RequirePermission('Permission.Accounting.Views')
  @ApiOperation({ summary: 'Карточка категории расхода' })
  @ApiDataResponse(ExpenseCategoryDto, { description: 'Категория расхода' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<ExpenseCategoryDto> {
    return this.categories.findOne(id);
  }

  @Post()
  @RequirePermission('Permission.Accounting.ManageExpenses')
  @ApiOperation({
    summary: 'Новая категория расхода',
    description:
      'Название уникально без учёта регистра (409). `parentId` вкладывает статью в раздел; ' +
      'глубина ограничена двумя уровнями — подкатегорию в подкатегорию вложить нельзя (422).',
  })
  @ApiDataResponse(ExpenseCategoryDto, {
    status: HttpStatus.CREATED,
    description: 'Категория заведена',
  })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  create(@Body() dto: CreateExpenseCategoryDto): Promise<ExpenseCategoryDto> {
    return this.categories.create(dto);
  }

  @Put(':id')
  @RequirePermission('Permission.Accounting.ManageExpenses')
  @ApiOperation({
    summary: 'Правка категории расхода',
    description:
      'Пустой `parentId` поднимает категорию на верхний уровень. Перевод в `INACTIVE` ' +
      'закрывает статью для **новых** расходов (422), уже проведённые её не теряют.',
  })
  @ApiDataResponse(ExpenseCategoryDto, { description: 'Обновлённая категория' })
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
    @Body() dto: UpdateExpenseCategoryDto,
  ): Promise<ExpenseCategoryDto> {
    return this.categories.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('Permission.Accounting.ManageExpenses')
  @ApiOperation({
    summary: 'Удаление категории расхода',
    description:
      'Категория с расходами или с подкатегориями не удаляется (409) — выведите её из работы.',
  })
  @ApiDataResponse(ExpenseCategoryDeletedDto, { description: 'Категория удалена' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<ExpenseCategoryDeletedDto> {
    return this.categories.remove(id);
  }
}
