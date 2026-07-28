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
import type { Paginated } from '../common';
import { ApiDataResponse, ApiPaginatedResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import {
  CreatePaymentTypeDto,
  PaymentTypeDeletedDto,
  PaymentTypeDto,
  PaymentTypesQueryDto,
  UpdatePaymentTypeDto,
} from './dto';
import { PaymentTypesService } from './payment-types.service';

/**
 * Справочник способов оплаты (ТЗ 5.16: «тип Cash/Alif»).
 *
 * Весь раздел Accounting доступен только позиции `Director` — это правило
 * Фазы 2 (`DIRECTOR_ONLY_SECTIONS`, сессия 0006): права `Permission.Accounting.*`
 * другой позиции просто не выдаются (422), поэтому здесь достаточно обычной
 * проверки права.
 */
@ApiTags('Accounting')
@ApiBearerAuth('access-token')
@Controller('accounting/payment-types')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class PaymentTypesController {
  constructor(private readonly types: PaymentTypesService) {}

  @Get()
  @RequirePermission('Permission.Accounting.Views')
  @ApiOperation({
    summary: 'Способы оплаты',
    description:
      'Справочник способов оплаты (ТЗ 5.16). `search` ищет по названию и описанию. ' +
      'В строке — сколько платежей принято этим способом: способ с платежами не удаляется.',
  })
  @ApiPaginatedResponse(PaymentTypeDto, { description: 'Способы оплаты' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: PaymentTypesQueryDto): Promise<Paginated<PaymentTypeDto>> {
    return this.types.findAll(query);
  }

  @Get(':id')
  @RequirePermission('Permission.Accounting.Views')
  @ApiOperation({ summary: 'Карточка способа оплаты' })
  @ApiDataResponse(PaymentTypeDto, { description: 'Способ оплаты' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<PaymentTypeDto> {
    return this.types.findOne(id);
  }

  @Post()
  @RequirePermission('Permission.Accounting.ManagePayments')
  @ApiOperation({
    summary: 'Новый способ оплаты',
    description: 'Название уникально без учёта регистра (409), как во всех справочниках проекта.',
  })
  @ApiDataResponse(PaymentTypeDto, {
    status: HttpStatus.CREATED,
    description: 'Способ оплаты заведён',
  })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
  )
  create(@Body() dto: CreatePaymentTypeDto): Promise<PaymentTypeDto> {
    return this.types.create(dto);
  }

  @Put(':id')
  @RequirePermission('Permission.Accounting.ManagePayments')
  @ApiOperation({
    summary: 'Правка способа оплаты',
    description:
      'Перевод в `INACTIVE` закрывает способ для **новых** платежей (422), но уже принятые ' +
      'его не теряют — та же асимметрия, что у ступени ментора (0021).',
  })
  @ApiDataResponse(PaymentTypeDto, { description: 'Обновлённый способ оплаты' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentTypeDto,
  ): Promise<PaymentTypeDto> {
    return this.types.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('Permission.Accounting.ManagePayments')
  @ApiOperation({
    summary: 'Удаление способа оплаты',
    description: 'Способ, которым уже платили, не удаляется (409) — выведите его из работы.',
  })
  @ApiDataResponse(PaymentTypeDeletedDto, { description: 'Способ оплаты удалён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<PaymentTypeDeletedDto> {
    return this.types.remove(id);
  }
}
