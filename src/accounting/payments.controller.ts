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
  ChargeDeletedDto,
  ChargeMonthDto,
  ChargeRunResultDto,
  ChargesQueryDto,
  CreatePaymentDto,
  CreatePrepaymentDto,
  PaymentDeletedDto,
  PaymentTotalsDto,
  PaymentTransactionDto,
  ReasonDto,
  StudentPaymentCardDto,
  StudentPaymentDto,
  TransactionsQueryDto,
  UpdateChargeDto,
  UpdatePaymentDto,
} from './dto';
import { PaymentsService } from './payments.service';

/**
 * Оплаты студентов (ТЗ 5.16: «Payment's»).
 *
 * Раздел Accounting доступен только позиции `Director` — правило Фазы 2
 * (`DIRECTOR_ONLY_SECTIONS`, сессия 0006).
 *
 * **Порядок объявления маршрутов значим:** `charges` и `transactions` стоят
 * выше `:id`, иначе Nest увёл бы их в параметр пути и `ParseUUIDPipe` ответил
 * бы 400 на существующий эндпоинт. Ровно эта ловушка ловилась в сессии 0028
 * с `GET /leads/export`, и на неё есть e2e-тест.
 */
@ApiTags('Accounting')
@ApiBearerAuth('access-token')
@Controller('accounting/payments')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('charges')
  @RequirePermission('Permission.Accounting.ManagePayments')
  @ApiOperation({
    summary: 'Начислить месяц',
    description:
      'Помесячное начисление из ТЗ 5.16: каждому студенту **действующего** состава ' +
      'заводится месяц со стоимостью его курса. Сумма кладётся снимком — правка Fee ' +
      'в каталоге прошлые месяцы не переписывает. Запуск идемпотентен: уже начисленные ' +
      'пары «студент + группа» пропускаются и считаются в `skipped`. Без `groupId` месяц ' +
      'начисляется всем группам центра, кроме отменённых.',
  })
  @ApiDataResponse(ChargeRunResultDto, {
    status: HttpStatus.CREATED,
    description: 'Месяц начислен',
  })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  chargeMonth(
    @Body() dto: ChargeMonthDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ChargeRunResultDto> {
    return this.payments.chargeMonth(dto, user.accountId);
  }

  @Get('transactions')
  @RequirePermission('Permission.Accounting.Views')
  @ApiOperation({
    summary: 'История платежей',
    description:
      'Полученные деньги (ТЗ 5.16). `prepayment=true` оставляет только предоплаты — ' +
      'платежи, ещё не разнесённые по месяцам. Сумма отобранного набора уходит ' +
      'в `meta.totalAmount`. Период задаётся месяцами **получения денег** и не совпадает ' +
      'с месяцем начисления: сентябрь оплачивают и в августе, и в октябре.',
  })
  @ApiPaginatedResponse(PaymentTransactionDto, {
    description: 'Платежи; сумма набора — в `meta.totalAmount`',
    meta: {
      totalAmount: { type: 'number', description: 'Сумма всех отобранных платежей, TJS.' },
    },
  })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAllTransactions(
    @Query() query: TransactionsQueryDto,
  ): Promise<Paginated<PaymentTransactionDto>> {
    return this.payments.findAllTransactions(query);
  }

  @Put('transactions/:id')
  @RequirePermission('Permission.Accounting.ManagePayments')
  @ApiOperation({
    summary: 'Правка платежа с причиной',
    description:
      'Правка «с причиной» из ТЗ 5.16 — причина обязательна и хранится последняя. ' +
      'Этим же запросом **предоплата разносится по месяцу**: `chargeId` со значением ' +
      'привязывает платёж к месяцу того же студента, пустая строка возвращает его ' +
      'в предоплату. Сумма не может превышать остаток месяца, в котором платёж окажется.',
  })
  @ApiDataResponse(PaymentTransactionDto, { description: 'Изменённый платёж' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  updateTransaction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaymentTransactionDto> {
    return this.payments.updateTransaction(id, dto, user.accountId);
  }

  @Delete('transactions/:id')
  @RequirePermission('Permission.Accounting.ManagePayments')
  @ApiOperation({
    summary: 'Отмена платежа',
    description:
      'Сверх перечня маршрутов ТЗ 5.16: правка суммы не помогает, если деньги записаны ' +
      'не тому студенту. Причина обязательна и уходит в лог (с Фазой 13 — в аудит). ' +
      'Остаток месяца пересчитывается той же транзакцией.',
  })
  @ApiDataResponse(PaymentDeletedDto, { description: 'Платёж отменён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  removeTransaction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ): Promise<PaymentDeletedDto> {
    return this.payments.removeTransaction(id, dto);
  }

  @Post('prepayment')
  @RequirePermission('Permission.Accounting.ManagePayments')
  @ApiOperation({
    summary: 'Предоплата',
    description:
      '«Prepayment для текущего/нового студента» из ТЗ 5.16: деньги приняты до того, ' +
      'как месяц начислен. Это тот же платёж, только без месяца — отдельной модели ' +
      'предоплата не требует. Разносится она правкой платежа (`PUT …/transactions/{id}` ' +
      'с `chargeId`), и **до разноса долг она не гасит**: в витрине должников она стоит ' +
      'отдельной колонкой.',
  })
  @ApiDataResponse(PaymentTransactionDto, {
    status: HttpStatus.CREATED,
    description: 'Предоплата принята',
  })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  prepay(
    @Body() dto: CreatePrepaymentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaymentTransactionDto> {
    return this.payments.prepay(dto, user.accountId);
  }

  @Get()
  @RequirePermission('Permission.Accounting.Views')
  @ApiOperation({
    summary: 'Начисления и их оплата',
    description:
      'Экран «Payment’s» из ТЗ 5.16: строка — это **месяц обучения** студента в группе ' +
      'со статусом (`PAID` / `PARTIAL` / `NOT_PAID`), суммой, скидкой и остатком. ' +
      'Итоги «Total payment / Paid / Not paid» считаются по всему отобранному набору ' +
      'и уходят в `meta.totals` — они одни на все страницы. Период задаётся месяцами ' +
      'начисления, `search` ищет по имени, фамилии, телефону и названию группы.',
  })
  @ApiExtraModels(PaymentTotalsDto)
  @ApiPaginatedResponse(StudentPaymentDto, {
    description: 'Начисления; итоги — в `meta.totals`',
    meta: {
      totals: {
        $ref: getSchemaPath(PaymentTotalsDto),
        description: 'Total payment / Paid / Not paid по всему отобранному набору (ТЗ 5.16).',
      },
    },
  })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAllCharges(@Query() query: ChargesQueryDto): Promise<Paginated<StudentPaymentDto>> {
    return this.payments.findAllCharges(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Accounting.ManagePayments')
  @ApiOperation({
    summary: 'Приём оплаты',
    description:
      'Принимает деньги по конкретному месяцу (ТЗ 5.16). Сумма **не может превышать ' +
      'остаток месяца** (422): переплата — это предоплата, а не «месяц, оплаченный ' +
      'дважды». Благодаря этому долг центра складывается из остатков месяцев без ' +
      'вычитаний в обе стороны.',
  })
  @ApiDataResponse(PaymentTransactionDto, {
    status: HttpStatus.CREATED,
    description: 'Оплата принята',
  })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  pay(
    @Body() dto: CreatePaymentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaymentTransactionDto> {
    return this.payments.pay(dto, user.accountId);
  }

  @Get(':id')
  @RequirePermission('Permission.Accounting.Views')
  @ApiOperation({
    summary: 'Карточка начисления',
    description:
      'Месяц вместе с платежами, которые его закрывают. Принятая сумма здесь считается ' +
      'по самим платежам, а не берётся из хранимой колонки: список уже прочитан, ' +
      'и расхождение было бы видно сразу.',
  })
  @ApiDataResponse(StudentPaymentCardDto, { description: 'Начисление с платежами' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findCharge(@Param('id', ParseUUIDPipe) id: string): Promise<StudentPaymentCardDto> {
    return this.payments.findCharge(id);
  }

  @Put(':id')
  @RequirePermission('Permission.Accounting.ManagePayments')
  @ApiOperation({
    summary: 'Скидка и примечание к месяцу',
    description:
      'Скидка из ТЗ 5.16 — в сомони и **с обязательной причиной**. Она не может быть больше ' +
      'начисленного (400) и не может опустить сумму к оплате ниже уже принятых денег (422): ' +
      'иначе месяц оказался бы переплаченным, а вернуть переплату нечем. Сумма начисления ' +
      'и принятые платежи здесь не правятся.',
  })
  @ApiDataResponse(StudentPaymentDto, { description: 'Обновлённое начисление' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  updateCharge(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateChargeDto,
  ): Promise<StudentPaymentDto> {
    return this.payments.updateCharge(id, dto);
  }

  @Delete(':id')
  @RequirePermission('Permission.Accounting.ManagePayments')
  @ApiOperation({
    summary: 'Удаление начисления',
    description:
      'Сверх перечня маршрутов ТЗ 5.16: месяц начисляется пачкой по всему составу, ' +
      'и ошибка оператора иначе висела бы долгом навсегда. Месяц с принятыми платежами ' +
      'не удаляется (409) — сначала отменяют платежи. Причина обязательна.',
  })
  @ApiDataResponse(ChargeDeletedDto, { description: 'Начисление удалено' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  removeCharge(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ): Promise<ChargeDeletedDto> {
    return this.payments.removeCharge(id, dto);
  }
}
