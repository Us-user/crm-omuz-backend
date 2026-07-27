import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import {
  CloseMonthDto,
  LeaderDto,
  LeadersQueryDto,
  MonthWinnersDto,
  MonthWinnersRemovedDto,
  WinnersQueryDto,
} from './dto';
import { LeadersService } from './leaders.service';

/**
 * Лидеры и рейтинг центра (ТЗ 5.13).
 *
 * Просмотр закрыт `Permission.Leaders.Views` — код лежал в каталоге с сессии
 * 0005 и до сих пор никем не требовался. Закрытие месяца — своим правом
 * `ManageWinners`: видеть рейтинг нужно всем, кто работает со студентами,
 * а фиксировать победителей — не всем, потому что снимок не пересчитывается
 * и остаётся в истории центра.
 *
 * Своего рейтинга студент здесь не видит: у него есть `GET /me/performance`
 * (кабинет, ТЗ 5.3), где место выводится из токена, а не из адреса.
 */
@ApiTags('Leaders')
@ApiBearerAuth('access-token')
@Controller('leaders')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class LeadersController {
  constructor(private readonly leaders: LeadersService) {}

  @Get()
  @RequirePermission('Permission.Leaders.Views')
  @ApiOperation({
    summary: 'Рейтинг центра',
    description:
      'Постраничный список по общему баллу (ТЗ 5.8: среднее `Sum` по **финализированным** ' +
      'неделям). Топ-3 отдаётся в `meta.top` — он один на все страницы. Корона (ТЗ 5.3) — ' +
      'место №1; при равенстве баллов место одно на всех, и корона у всех первых. ' +
      'В рейтинг идут только студенты с действующим членством: у выпускника балл есть, ' +
      'а места нет. Фильтры `groupId`/`courseId` считают балл **по неделям среза**, ' +
      'а не общий, — так же, как счётчики категорий в карточке группы.',
  })
  @ApiPaginatedResponse(LeaderDto, {
    description: 'Рейтинг по общему баллу; топ-3 — в `meta.top`',
    meta: {
      top: {
        type: 'array',
        description:
          'Первые три места (ТЗ 5.13). При ничьей на третьем месте строк может быть больше.',
        items: { type: 'object' },
      },
    },
  })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: LeadersQueryDto): Promise<Paginated<LeaderDto>> {
    return this.leaders.findAll(query);
  }

  @Get('winners')
  @RequirePermission('Permission.Leaders.Views')
  @ApiOperation({
    summary: 'Победители месяца',
    description:
      'Снимок месяца (ТЗ 5.13: «Winners of the last month»). Без `month` отдаётся ' +
      'последний **закрытый** месяц. Снимок хранится и **не пересчитывается**: правка ' +
      'журнала задним числом победителей прошлого месяца не меняет. Незакрытый месяц — ' +
      'это `closed: false` и пустой список, а не 404.',
  })
  @ApiDataResponse(MonthWinnersDto, { description: 'Снимок победителей месяца' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findWinners(@Query() query: WinnersQueryDto): Promise<MonthWinnersDto> {
    return this.leaders.findWinners(query);
  }

  @Post('winners')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Leaders.ManageWinners')
  @ApiOperation({
    summary: 'Закрытие месяца (фиксация победителей)',
    description:
      'Считает средний `Sum` по финализированным неделям месяца (неделя относится ' +
      'к месяцу своей даты начала) и сохраняет первые `places` мест снимком. ' +
      'Осознанное действие, как «Отправить результат» у недели журнала. ' +
      'Повторное закрытие — 409: снимок не пересчитывается, ошибочный снимается `DELETE`. ' +
      'Незавершившийся месяц — 422, месяц без единой финализированной недели — тоже 422. ' +
      'Фильтра «учится сейчас» здесь нет: снимок отвечает, кто учился лучше всех **тогда**.',
  })
  @ApiDataResponse(MonthWinnersDto, {
    description: 'Месяц закрыт, победители зафиксированы',
    status: HttpStatus.CREATED,
  })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  closeMonth(
    @Body() dto: CloseMonthDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<MonthWinnersDto> {
    return this.leaders.closeMonth(dto, actor.accountId);
  }

  @Delete('winners/:month')
  @RequirePermission('Permission.Leaders.ManageWinners')
  @ApiOperation({
    summary: 'Снятие снимка месяца',
    description:
      'Маршрута нет в перечне ТЗ 5.13, но без него ошибочно закрытый месяц остался бы ' +
      'навсегда: повторное закрытие отклоняется 409, и вернуться в состояние «месяц ' +
      'не закрыт» было бы нечем. Право то же, что у закрытия. Месяц адресуется своим ' +
      'значением `YYYY-MM` — у снимка это естественный ключ.',
  })
  @ApiParam({ name: 'month', example: '2026-06', description: 'Месяц в формате YYYY-MM' })
  @ApiDataResponse(MonthWinnersRemovedDto, { description: 'Снимок месяца снят' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  reopenMonth(@Param('month') month: string): Promise<MonthWinnersRemovedDto> {
    return this.leaders.reopenMonth(month);
  }
}
