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
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';
import type { Response } from 'express';

import type { AuthenticatedUser } from '../auth';
import { AccountTypeGuard, CurrentUser, RequireAccountType } from '../auth';
import type { Paginated } from '../common';
import { ApiDataResponse, ApiPaginatedResponse, ApiStandardErrors, RawResponse } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import {
  AccountingPeriodDeletedDto,
  AccountingPeriodDto,
  AccountingPeriodsQueryDto,
  CreateAccountingPeriodDto,
  UpdateAccountingPeriodDto,
} from './dto';
import { PeriodsService } from './periods.service';

/**
 * Финансовые периоды-отчёты (ТЗ 5.16: `GET /accounting/periods`,
 * `POST /accounting/periods/{id}/close`).
 *
 * Раздел Accounting доступен только позиции `Director` — правило Фазы 2
 * (`DIRECTOR_ONLY_SECTIONS`, сессия 0006). Ведение периодов закрыто правом
 * `Permission.Accounting.ManagePeriods`, которое лежало в каталоге с сессии
 * 0005 и до сих пор ничего не открывало.
 */
@ApiTags('Accounting')
@ApiBearerAuth('access-token')
@Controller('accounting/periods')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class PeriodsController {
  constructor(private readonly periods: PeriodsService) {}

  @Get()
  @RequirePermission('Permission.Accounting.Views')
  @ApiOperation({
    summary: 'Финансовые периоды-отчёты',
    description:
      'ТЗ 5.16: «Accountant: финансовые периоды-отчёты income/expense/paid/notpaid/net». ' +
      'У периода **в работе** числа считаются на лету и меняются вместе с кассой; ' +
      'у **закрытого** они взяты из снимка (`frozen: true`) и правкой задним числом ' +
      'больше не двигаются.\n\n' +
      'Периоды **не пересекаются** — осознанно иначе, чем бюджеты: один платёж в двух ' +
      'отчётах дал бы два ответа на вопрос «сколько центр заработал». Фильтр `from`/`to` ' +
      'при этом отбирает по **пересечению** с отрезком.',
  })
  @ApiPaginatedResponse(AccountingPeriodDto, { description: 'Периоды с отчётами' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: AccountingPeriodsQueryDto): Promise<Paginated<AccountingPeriodDto>> {
    return this.periods.findAll(query);
  }

  @Post()
  @RequirePermission('Permission.Accounting.ManagePeriods')
  @ApiOperation({
    summary: 'Завести финансовый период',
    description:
      'Период задаётся месяцами, обе границы включительно, — месяцем, кварталом или годом. ' +
      'Пересечение с уже заведённым периодом отклоняется (422) с названием мешающего.',
  })
  @ApiDataResponse(AccountingPeriodDto, {
    status: HttpStatus.CREATED,
    description: 'Период заведён',
  })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  create(
    @Body() dto: CreateAccountingPeriodDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AccountingPeriodDto> {
    return this.periods.create(dto, user.accountId);
  }

  @Get(':id')
  @RequirePermission('Permission.Accounting.Views')
  @ApiOperation({
    summary: 'Карточка периода',
    description:
      'Отчёт периода: `charged`/`paid`/`debt` считаются по **месяцам обучения** (это план), ' +
      '`income` и `salary` — по дню движения денег (это касса), `net = income − expense − salary`. ' +
      'Путать их нельзя: неоплаченный месяц увеличивает долг, но не увеличивает приход.',
  })
  @ApiDataResponse(AccountingPeriodDto, { description: 'Период с отчётом' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<AccountingPeriodDto> {
    return this.periods.findOne(id);
  }

  @Put(':id')
  @RequirePermission('Permission.Accounting.ManagePeriods')
  @ApiOperation({
    summary: 'Правка периода',
    description:
      'Название, описание и границы. Статуса в теле нет намеренно: закрытие — отдельное ' +
      'действие со своим снимком (`POST …/close`), и менять его заодно с названием значило ' +
      'бы снимать отчёт молча. Закрытый период не правится (422).',
  })
  @ApiDataResponse(AccountingPeriodDto, { description: 'Обновлённый период' })
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
    @Body() dto: UpdateAccountingPeriodDto,
  ): Promise<AccountingPeriodDto> {
    return this.periods.update(id, dto);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('Permission.Accounting.ManagePeriods')
  @ApiOperation({
    summary: 'Закрытие периода (Inprogress → Archive)',
    description:
      'ТЗ 5.16. Числа отчёта **замораживаются снимком**: последующая правка платежа, ' +
      'расхода или выплаты их больше не двигает — сданный отчёт обязан пережить правки ' +
      'задним числом.\n\n' +
      'С этого момента период **не принимает операции, датированные внутри него**: ' +
      'приём оплаты, начисление месяца, расход и выплата зарплаты с датой в закрытом ' +
      'периоде отвечают 422. Платёж, датированный сегодняшним открытым днём, при этом ' +
      'принимается, даже если закрывает месяц из архива, — деньги пришли сегодня, ' +
      'и касса сегодняшняя.\n\n' +
      'Пустой период закрывается: «за квартал не было ни одной операции» — законный ' +
      'отчёт. Повторное закрытие — 409.',
  })
  @ApiDataResponse(AccountingPeriodDto, { description: 'Период закрыт, снимок снят' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  close(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AccountingPeriodDto> {
    return this.periods.close(id, user.accountId);
  }

  @Delete(':id/close')
  @RequirePermission('Permission.Accounting.ManagePeriods')
  @ApiOperation({
    summary: 'Снятие закрытия (Archive → Inprogress)',
    description:
      'Сверх перечня маршрутов ТЗ 5.16 и прямое следствие того, что архивный период ' +
      'запирает кассу: без обратного хода ошибочно закрытый квартал навсегда запретил бы ' +
      'правки внутри себя. Снимок гасится целиком, числа снова считаются на лету. ' +
      'Незакрытый период — 422.',
  })
  @ApiDataResponse(AccountingPeriodDto, { description: 'Закрытие снято, период снова в работе' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  reopen(@Param('id', ParseUUIDPipe) id: string): Promise<AccountingPeriodDto> {
    return this.periods.reopen(id);
  }

  @Get(':id/export')
  @RawResponse()
  @RequirePermission('Permission.Accounting.Views')
  @ApiOperation({
    summary: 'Выгрузка отчёта периода в CSV',
    description:
      'ТЗ 5.16: «выгрузка». Отдаётся файл, а не `{ data }`: `text/csv` с BOM — Excel под ' +
      'Windows иначе читает UTF-8 как cp1251. Строка на каждый месяц периода плюс итоговая; ' +
      'месяц без операций остаётся в файле нулями.\n\n' +
      'Итог берётся из того же источника, что и карточка (у закрытого периода — из снимка), ' +
      'а месячные строки считаются по живым данным: у архивного периода их сумма может ' +
      'разойтись с итогом, и это видимый признак того, что кассу правили после закрытия.\n\n' +
      'Право `Views`, а не отдельное: в отличие от выгрузок состава и воронки (0013, 0028) ' +
      'здесь нет персональных данных — только сводные числа, уже показанные на экране.',
  })
  @ApiProduces('text/csv')
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'CSV с отчётом периода',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  async exportCsv(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const file = await this.periods.exportCsv(id);

    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    // Два имени по RFC 6266: ASCII — для клиентов, не понимающих `filename*`,
    // кириллическое — для всех остальных (тот же приём, что в 0013 и 0028).
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.asciiFileName}"; ` +
        `filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );

    return file.content;
  }

  @Delete(':id')
  @RequirePermission('Permission.Accounting.ManagePeriods')
  @ApiOperation({
    summary: 'Удаление периода',
    description:
      'Сверх перечня маршрутов ТЗ 5.16, как удаление бюджета (0031). Причина не требуется: ' +
      'исчезает рамка отчёта, а не запись о деньгах — платежи и расходы остаются на месте. ' +
      'Закрытый период не удаляется (422): сначала снимите закрытие.',
  })
  @ApiDataResponse(AccountingPeriodDeletedDto, { description: 'Период удалён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<AccountingPeriodDeletedDto> {
    return this.periods.remove(id);
  }
}
