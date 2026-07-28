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
import { CouponsService } from './coupons.service';
import {
  CouponDeletedDto,
  CouponDto,
  CouponQueryDto,
  CreateCouponDto,
  UpdateCouponDto,
} from './dto';

/**
 * Купоны (ТЗ 5.7).
 *
 * Справочник маркетингового контура: сумма скидки в сомони, период действия,
 * Active/Inactive и мультивыбор курсов. Применение купона **к оплате** отложено
 * из v1 (ТЗ §6) — здесь купон только заводится и выбирается в карточке лида.
 */
@ApiTags('Coupons')
@ApiBearerAuth('access-token')
@Controller('coupons')
// Маркетинговый контур ведут сотрудники; студенту положен только просмотр
// своих данных (ТЗ 3.2). Конкретное действие проверяет право каталога.
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Get()
  @RequirePermission('Permission.Coupons.Views')
  @ApiOperation({
    summary: 'Список купонов',
    description:
      'Постраничный список (ТЗ 5.7). `search` — по названию и описанию. Фильтр ' +
      '`courseId` отбирает купоны, действующие на курс, **включая купоны «на все ' +
      'курсы»** (с пустым набором): иначе он отвечал бы не на вопрос «чем можно ' +
      'воспользоваться», а на вопрос «что перечислено поимённо». Фильтр ' +
      '`currentlyValid` сверяет статус и период с сегодняшним днём.',
  })
  @ApiPaginatedResponse(CouponDto, { description: 'Купоны' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: CouponQueryDto): Promise<Paginated<CouponDto>> {
    return this.coupons.findAll(query);
  }

  @Get(':id')
  @RequirePermission('Permission.Coupons.Views')
  @ApiOperation({ summary: 'Карточка купона' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(CouponDto, { description: 'Купон' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<CouponDto> {
    return this.coupons.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Coupons.Create')
  @ApiOperation({
    summary: 'Создание купона',
    description:
      'Название уникально без учёта регистра (409). Обе границы периода ' +
      'необязательны и включающие; конец раньше начала — 400. **Пустой набор ' +
      '`courseIds` означает «на все курсы»**, а несуществующий курс в наборе — 422 ' +
      'с перечислением только недостающих.',
  })
  @ApiDataResponse(CouponDto, { status: HttpStatus.CREATED, description: 'Купон создан' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  create(@Body() dto: CreateCouponDto): Promise<CouponDto> {
    return this.coupons.create(dto);
  }

  @Put(':id')
  @RequirePermission('Permission.Coupons.Update')
  @ApiOperation({
    summary: 'Правка купона',
    description:
      'Не переданное поле остаётся прежним, пустая строка очищает текст или снимает ' +
      'границу периода. `courseIds` **заменяет набор целиком**: при слиянии снять ' +
      'курс было бы нечем. Период сверяется по итоговому состоянию — новая граница ' +
      'сравнивается с той, что уже лежит в БД.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(CouponDto, { description: 'Обновлённый купон' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCouponDto): Promise<CouponDto> {
    return this.coupons.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('Permission.Coupons.Delete')
  @ApiOperation({
    summary: 'Удаление купона',
    description:
      'Купон, обещанный хотя бы одному лиду, не удаляется (409) — переведите его ' +
      'в `INACTIVE`. Мультивыбор курсов уходит вместе с купоном: он часть самой записи.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(CouponDeletedDto, { description: 'Купон удалён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<CouponDeletedDto> {
    return this.coupons.remove(id);
  }
}
