import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import { AccountTypeGuard, RequireAccountType } from '../auth';
import { ApiDataResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { OverviewDto, OverviewQueryDto } from './dto';
import { OverviewService } from './overview.service';

/**
 * Обзор бухгалтерии (ТЗ 5.16, `GET /accounting/overview`).
 *
 * Раздел Accounting доступен только позиции `Director` — правило Фазы 2
 * (`DIRECTOR_ONLY_SECTIONS`, сессия 0006). Витрина только читает: своих
 * действий у обзора нет, и права `Views` достаточно.
 */
@ApiTags('Accounting')
@ApiBearerAuth('access-token')
@Controller('accounting/overview')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get()
  @RequirePermission('Permission.Accounting.Views')
  @ApiOperation({
    summary: 'Обзор бухгалтерии',
    description:
      'Total payment / Paid / Not paid, Income vs Expense по месяцам, расходы по категориям ' +
      'и «Students payment по группам» (ТЗ 5.16).\n\n' +
      '**Чисел два вида, и путать их нельзя.** `charges` считаются по месяцам обучения — ' +
      'это план: неоплаченный месяц увеличивает `charged` и `debt`. `income` считается ' +
      'по дню, когда деньги пришли, вместе с предоплатами — это касса. `Net = income − expense`.\n\n' +
      'Период задаётся месяцами: по умолчанию последние 12, длиннее 60 — 400. ' +
      'Фильтра по филиалу нет намеренно: предоплата заведена на студента, а не на группу, ' +
      'и такой фильтр молча выкидывал бы её из `income`.',
  })
  @ApiDataResponse(OverviewDto, { description: 'Обзор за период' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  find(@Query() query: OverviewQueryDto): Promise<OverviewDto> {
    return this.overview.find(query);
  }
}
