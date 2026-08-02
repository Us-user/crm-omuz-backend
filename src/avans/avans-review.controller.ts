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
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import type { AuthenticatedUser } from '../auth';
import { AccountTypeGuard, CurrentUser, RequireAccountType } from '../auth';
import type { Paginated } from '../common';
import { ApiDataResponse, ApiPaginatedResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { AvansReviewService } from './avans-review.service';
import {
  ApproveAvansDto,
  AvansReviewQueryDto,
  AvansReviewRequestDto,
  DenyAvansDto,
  ReopenAvansDto,
} from './dto';

/**
 * Рассмотрение заявок на аванс (ТЗ 5.16: `GET/POST /accounting/avans`,
 * `POST /accounting/avans/{id}/approve|deny`).
 *
 * Права — `Permission.Avans.*`, а не `Permission.Accounting.*`: раздел
 * Accounting закрыт на `Director` (0006), а рассматривать заявки вправе
 * и бухгалтер. `POST /accounting/avans` из перечня ТЗ здесь **не заводится** —
 * подача уже есть по адресу сотрудника (`POST /employees/{id}/avans`, 0022)
 * и в кабинете ментора (0023); третий способ завести заявку был бы третьим
 * набором правил о том же.
 */
@ApiTags('Accounting')
@ApiBearerAuth('access-token')
@Controller('accounting/avans')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class AvansReviewController {
  constructor(private readonly review: AvansReviewService) {}

  @Get()
  @RequirePermission('Permission.Avans.Views')
  @ApiOperation({
    summary: 'Очередь заявок на аванс',
    description:
      'Заявки по всему центру: без фильтра — все, `?status=PENDING` — только ждущие ' +
      'решения. Период задаётся **месяцами зарплаты**, а не датами подачи: одобренный ' +
      'аванс становится `Prepaid` месяца (ТЗ 5.16). Поиск — по имени, фамилии и причине.',
  })
  @ApiPaginatedResponse(AvansReviewRequestDto, { description: 'Заявки с сотрудником в строке' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: AvansReviewQueryDto): Promise<Paginated<AvansReviewRequestDto>> {
    return this.review.findAll(query);
  }

  @Get(':id')
  @RequirePermission('Permission.Avans.Views')
  @ApiOperation({ summary: 'Карточка заявки' })
  @ApiDataResponse(AvansReviewRequestDto, { description: 'Заявка' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<AvansReviewRequestDto> {
    return this.review.findOne(id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('Permission.Avans.Approve')
  @ApiOperation({
    summary: 'Одобрить заявку',
    description:
      'Заявка становится `Prepaid` месяца (ТЗ 5.16). Повторное рассмотрение — 409: ' +
      'ошибочное решение снимается `DELETE …/review`, а не переписывается вторым. ' +
      'Выведенному из штата сотруднику аванс не одобряется (422) — отклоните заявку ' +
      'или верните его в штат. Комментарий необязателен.',
  })
  @ApiDataResponse(AvansReviewRequestDto, { description: 'Заявка одобрена' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveAvansDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AvansReviewRequestDto> {
    return this.review.approve(id, dto, user.accountId);
  }

  @Post(':id/deny')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('Permission.Avans.Approve')
  @ApiOperation({
    summary: 'Отклонить заявку',
    description:
      'Причина **обязательна** — в этом асимметрия с одобрением: человек, которому ' +
      'отказали, должен узнать почему. Отклонённая заявка не мешает подать новую.',
  })
  @ApiDataResponse(AvansReviewRequestDto, { description: 'Заявка отклонена' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  deny(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DenyAvansDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AvansReviewRequestDto> {
    return this.review.deny(id, dto, user.accountId);
  }

  @Delete(':id/review')
  @RequirePermission('Permission.Avans.Approve')
  @ApiOperation({
    summary: 'Снять рассмотрение',
    description:
      'Сверх перечня маршрутов ТЗ 5.16: ошибочно одобренная заявка иначе осталась бы ' +
      'одобренной навсегда — отозвать её нельзя, рассмотренная не отзывается (0022). ' +
      'Возвращает заявку в `PENDING` и гасит все колонки решения. 409, если у сотрудника ' +
      'уже есть другая нерассмотренная заявка. Причина обязательна и уходит в лог.',
  })
  @ApiDataResponse(AvansReviewRequestDto, { description: 'Рассмотрение снято' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  reopen(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReopenAvansDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AvansReviewRequestDto> {
    return this.review.reopen(id, dto, user.accountId);
  }
}
