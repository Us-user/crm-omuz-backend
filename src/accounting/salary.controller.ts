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
  CreateSalarySheetDto,
  PaySalaryDto,
  SalaryCardDto,
  SalaryDeletedDto,
  SalaryDto,
  SalaryQueryDto,
  SalaryReasonDto,
  SalarySheetCreatedDto,
  SalaryTotalsDto,
  SalaryTransactionDeletedDto,
  SalaryTransactionDto,
  UpdateSalaryDto,
} from './dto';
import { SalaryService } from './salary.service';

/**
 * Зарплата (ТЗ 5.16: «Salary», `GET /accounting/salary`,
 * `POST /accounting/salary/{id}/pay`).
 *
 * Раздел Accounting доступен только позиции `Director` — правило Фазы 2
 * (`DIRECTOR_ONLY_SECTIONS`, сессия 0006).
 *
 * Маршрут `transactions` объявлен **выше** `:id`: Nest сопоставляет пути
 * в порядке объявления, и ниже он уехал бы в параметр, где `ParseUUIDPipe`
 * ответил бы 400 на существующий эндпоинт (ловушка, пойманная в 0028 и 0029).
 */
@ApiTags('Accounting')
@ApiBearerAuth('access-token')
@Controller('accounting/salary')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class SalaryController {
  constructor(private readonly salary: SalaryService) {}

  @Get()
  @RequirePermission('Permission.Accounting.Views')
  @ApiOperation({
    summary: 'Ведомость зарплат за месяц',
    description:
      'Расчёты месяца (ТЗ 5.16: Total / Prepaid / Remaining / Paid). Период здесь — ' +
      '**один месяц**, а не отрезок: ставка уровня и аванс привязаны к месяцу, и отрезок ' +
      'сложил бы в одну строку два разных расчёта. Без `month` берётся текущий месяц.\n\n' +
      'У **черновика** часы берутся из журнала, а ставка — из уровня месяца, поэтому правка ' +
      'журнала сразу видна. У **подтверждённого** они из снимка и больше не меняются. ' +
      'Итоги по всему отобранному набору — в `meta.totals`, они одни на все страницы.\n\n' +
      'Сортировка `total` идёт по колонке снимка: у черновиков она пустая, и они уходят ' +
      'в конец списка.',
  })
  @ApiExtraModels(SalaryTotalsDto)
  @ApiPaginatedResponse(SalaryDto, {
    description: 'Ведомость месяца; итоги — в `meta.totals`',
    meta: {
      totals: {
        $ref: getSchemaPath(SalaryTotalsDto),
        description: 'Итоги по всему отобранному набору, а не по странице.',
      },
    },
  })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: SalaryQueryDto): Promise<Paginated<SalaryDto>> {
    return this.salary.findAll(query);
  }

  @Post()
  @RequirePermission('Permission.Accounting.ManageSalary')
  @ApiOperation({
    summary: 'Сформировать ведомость месяца',
    description:
      'Заводит расчёт каждому, у кого в этом месяце есть **фактически проведённые занятия** ' +
      '(день журнала с этим ведущим) или одобренная заявка на аванс. Второе обязательно: ' +
      'аванс человеку без часов всё равно выдан, и без строки расчёта он потерялся бы.\n\n' +
      'Действие осознанное, а не фоновая задача — работающих задач в проекте нет до Фазы 11 ' +
      '(тот же ход, что с начислением студентам). **Идемпотентно**: повторный запуск второй ' +
      'строки не заводит, а досоздаёт недостающие.',
  })
  @ApiDataResponse(SalarySheetCreatedDto, {
    status: HttpStatus.CREATED,
    description: 'Ведомость сформирована',
  })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  create(
    @Body() dto: CreateSalarySheetDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SalarySheetCreatedDto> {
    return this.salary.create(dto, user.accountId);
  }

  @Delete('transactions/:id')
  @RequirePermission('Permission.Accounting.ManageSalary')
  @ApiOperation({
    summary: 'Отмена выплаты',
    description:
      'Сверх перечня маршрутов ТЗ 5.16 — как отмена платежа студента (0029): ошибочная ' +
      'выплата иначе осталась бы в отчёте навсегда. Причина обязательна и уходит в лог.',
  })
  @ApiDataResponse(SalaryTransactionDeletedDto, { description: 'Выплата отменена' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  removeTransaction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SalaryReasonDto,
  ): Promise<SalaryTransactionDeletedDto> {
    return this.salary.removeTransaction(id, dto);
  }

  @Get(':id')
  @RequirePermission('Permission.Accounting.Views')
  @ApiOperation({
    summary: 'Карточка расчёта',
    description:
      'Расчёт вместе с дневной раскладкой (ТЗ 5.16: «Daily salaries») и выплатами. ' +
      'Дневная строка — это учебный день журнала, который сотрудник провёл: своей таблицы ' +
      'у неё нет, `DailySalary` был бы копией журнала.',
  })
  @ApiDataResponse(SalaryCardDto, { description: 'Расчёт зарплаты' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<SalaryCardDto> {
    return this.salary.findOne(id);
  }

  @Put(':id')
  @RequirePermission('Permission.Accounting.ManageSalary')
  @ApiOperation({
    summary: 'Правка расчёта',
    description:
      'Премия («Bonus» из ТЗ 5.16) и примечание. Часы и ставку править нельзя: они приходят ' +
      'из журнала и справочника уровней, и ручной ввод завёл бы второй источник истины. ' +
      'Подтверждённый расчёт не правится (422) — сначала снимите подтверждение.',
  })
  @ApiDataResponse(SalaryDto, { description: 'Обновлённый расчёт' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSalaryDto): Promise<SalaryDto> {
    return this.salary.update(id, dto);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('Permission.Accounting.ManageSalary')
  @ApiOperation({
    summary: 'Подтверждение расчёта (Done)',
    description:
      '«Подтверждение Done» из ТЗ 5.16: часы, ставка и итог **замораживаются снимком**, ' +
      'и последующая правка журнала или пересмотр ставки в справочнике их больше не двигают.\n\n' +
      'Расчёт с часами, но без проставленного на этот месяц уровня ментора, подтвердить ' +
      'нельзя (422): ставки нет, и заморозить пришлось бы ноль. Повторное подтверждение — 409.',
  })
  @ApiDataResponse(SalaryDto, { description: 'Расчёт подтверждён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SalaryDto> {
    return this.salary.confirm(id, user.accountId);
  }

  @Delete(':id/confirm')
  @RequirePermission('Permission.Accounting.ManageSalary')
  @ApiOperation({
    summary: 'Снятие подтверждения',
    description:
      'Сверх перечня маршрутов ТЗ 5.16 и прямое следствие того, что подтверждённый расчёт ' +
      'не правится: ошибочно подтверждённый остался бы таким навсегда.\n\n' +
      'Расчёт с выплатами не размораживается (409) — деньги выданы по согласованной сумме; ' +
      'сначала отмените выплаты.',
  })
  @ApiDataResponse(SalaryDto, { description: 'Подтверждение снято, расчёт снова черновик' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  unconfirm(@Param('id', ParseUUIDPipe) id: string): Promise<SalaryDto> {
    return this.salary.unconfirm(id);
  }

  @Post(':id/pay')
  @RequirePermission('Permission.Accounting.ManageSalary')
  @ApiOperation({
    summary: 'Выплата по расчёту',
    description:
      'ТЗ 5.16: `POST /accounting/salary/{id}/pay`. Платить можно только по **подтверждённому** ' +
      'расчёту (422): у черновика сумма ещё меняется от правок журнала.\n\n' +
      'Выплата не может превышать остаток `Remaining = Total − Prepaid − Paid` (422) — ' +
      'то же правило, что у платежа студента: вернуть переплаченное нечем. Способ выплаты ' +
      'берётся из общего справочника (Cash/Alif); выведенный из работы — 422.',
  })
  @ApiDataResponse(SalaryTransactionDto, {
    status: HttpStatus.CREATED,
    description: 'Выплата проведена',
  })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PaySalaryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SalaryTransactionDto> {
    return this.salary.pay(id, dto, user.accountId);
  }

  @Delete(':id')
  @RequirePermission('Permission.Accounting.ManageSalary')
  @ApiOperation({
    summary: 'Удаление расчёта',
    description:
      'Сверх перечня маршрутов ТЗ 5.16: ведомость заводится пачкой по всему центру, ' +
      'и попавшая в неё лишняя строка иначе висела бы вечно. Подтверждённый расчёт ' +
      'не удаляется (422), расчёт с выплатами — тоже (409).',
  })
  @ApiDataResponse(SalaryDeletedDto, { description: 'Расчёт удалён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<SalaryDeletedDto> {
    return this.salary.remove(id);
  }
}
