import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import type { AuthenticatedUser } from '../auth';
import { AccountTypeGuard, CurrentUser, RequireAccountType } from '../auth';
import type { Paginated } from '../common';
import { ApiDataResponse, ApiPaginatedResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { AwardCoinsDto, CoinAwardedDto, CoinQueryDto, CoinTransactionDto } from './dto';
import { StudentCoinsService } from './student-coins.service';

/**
 * Коины студента (ТЗ 5.9). Маршруты вложены в студента: баланс и история
 * не существуют отдельно от того, кому они принадлежат.
 *
 * Просмотр закрыт `Permission.Coins.Views`, начисление — `Permission.Coins.Create`:
 * видеть баланс нужно всем, кто работает со студентами, а раздавать коины —
 * не всем. Оба кода лежали в каталоге с сессии 0005 и до сих пор никем
 * не требовались.
 */
@ApiTags('Coins')
@ApiBearerAuth('access-token')
@Controller('students/:studentId/coins')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class StudentCoinsController {
  constructor(private readonly coins: StudentCoinsService) {}

  @Get()
  @RequirePermission('Permission.Coins.Views')
  @ApiOperation({
    summary: 'Баланс и история коинов студента',
    description:
      'ТЗ 5.9: «Баланс и история у студента». Баланс отдаётся в `meta.balance` — ' +
      'он один на все страницы истории, и отдельный запрос ради одного числа ' +
      'был бы лишним. Фильтр `source` разделяет ручные начисления и автоматические ' +
      'по итогам недели журнала.',
  })
  @ApiParam({ name: 'studentId', format: 'uuid' })
  @ApiPaginatedResponse(CoinTransactionDto, {
    description: 'История начислений; баланс — в `meta.balance`',
    meta: {
      balance: { type: 'integer', example: 17, description: 'Текущий баланс коинов студента' },
    },
  })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findAll(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Query() query: CoinQueryDto,
  ): Promise<Paginated<CoinTransactionDto>> {
    return this.coins.findAll(studentId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Coins.Create')
  @ApiOperation({
    summary: 'Ручное начисление коинов',
    description:
      'ТЗ 5.9: начисляют сотрудники, причина обязательна. **Списание запрещено**: ' +
      'сумма только положительная, а истории начислений нельзя ни править, ни ' +
      'удалять. Автор берётся из токена — начислить от чужого имени нельзя.',
  })
  @ApiParam({ name: 'studentId', format: 'uuid' })
  @ApiDataResponse(CoinAwardedDto, { description: 'Коины начислены', status: HttpStatus.CREATED })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  award(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Body() dto: AwardCoinsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<CoinAwardedDto> {
    return this.coins.award(studentId, dto, actor.accountId);
  }
}
