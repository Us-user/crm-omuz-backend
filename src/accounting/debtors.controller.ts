import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import { AccountTypeGuard, RequireAccountType } from '../auth';
import type { Paginated } from '../common';
import { ApiPaginatedResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { DebtorsService } from './debtors.service';
import { DebtorDto, DebtorsQueryDto, DebtorsTotalsDto } from './dto';

/**
 * Должники (ТЗ 5.16: «Debtors»).
 *
 * Витрина только читает: долг гасится приёмом оплаты, и второго способа
 * «списать долг» здесь нет — он был бы вторым источником истины о деньгах
 * (то же решение, что у витрины покинувших курсы, 0025, где нет отчисления).
 * Поэтому `POST /accounting/debtors` из перечня ТЗ не заводится, и в OpenAPI
 * у пути описан только `get`.
 */
@ApiTags('Accounting')
@ApiBearerAuth('access-token')
@Controller('accounting/debtors')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class DebtorsController {
  constructor(private readonly debtors: DebtorsService) {}

  @Get()
  @RequirePermission('Permission.Accounting.Views')
  @ApiOperation({
    summary: 'Должники',
    description:
      'Студенты с незакрытыми месяцами (ТЗ 5.16: «Debtor = сумма неоплаченных месяцев»). ' +
      'Список отсортирован по убыванию долга; в строке — начислено и оплачено за период, ' +
      'число незакрытых месяцев и самый ранний из них. **Предоплата стоит отдельной ' +
      'колонкой и долг не гасит**: месяц закрывается разнесением платежа, а не наличием ' +
      'денег на счету. Итоги по всему набору — в `meta.totals`.',
  })
  @ApiExtraModels(DebtorsTotalsDto)
  @ApiPaginatedResponse(DebtorDto, {
    description: 'Должники; итоги — в `meta.totals`',
    meta: {
      totals: {
        $ref: getSchemaPath(DebtorsTotalsDto),
        description: 'Число должников и суммы по всему отобранному набору.',
      },
    },
  })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: DebtorsQueryDto): Promise<Paginated<DebtorDto>> {
    return this.debtors.findAll(query);
  }
}
