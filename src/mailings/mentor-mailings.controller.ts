import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import { MailingDto, MailingQueryDto, MailingSendResultDto, SendGroupMailingDto } from './dto';
import { MailingsService } from './mailings.service';

/**
 * Рассылки ментора своей группе (ТЗ 5.4: пункт меню «SMS mailings»).
 *
 * Живёт в модуле рассылок, а не в кабинете ментора, — прямое следствие решения
 * сессии 0023: «SMS mailings — это пункт меню, ведущий в модуль рассылок ТЗ 5.19».
 * Адрес общий с кабинетом (`/mentor`), но контроллер отдельный: это рассылки,
 * только суженные своей группой.
 *
 * Правил доступа те же, что во всём кабинете (0017, 0023): `@RequireAccountType`
 * пускает лишь сотрудника, а **прав каталога здесь нет** — ментор адресует
 * рассылку своей группе, что проверяется менторством, а не разрешением «писать
 * любой группе». Всё выводится из токена: чужие группы и чужие рассылки сюда
 * не попадают по построению.
 */
@ApiTags('Mentor cabinet')
@ApiBearerAuth('access-token')
@Controller('mentor/mailings')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class MentorMailingsController {
  constructor(private readonly mailings: MailingsService) {}

  @Get()
  @ApiOperation({
    summary: 'Свои рассылки',
    description:
      'Постраничный список рассылок, составленных вызывающим (ТЗ 5.4, раздел «SMS ' +
      'mailings»). Список сужен автором из токена — чужие рассылки сюда не попадают. ' +
      '`search` — по заголовку и тексту, `sent` разделяет черновики и отправленные.',
  })
  @ApiPaginatedResponse(MailingDto, { description: 'Рассылки ментора' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MailingQueryDto,
  ): Promise<Paginated<MailingDto>> {
    return this.mailings.findByAuthor(user.accountId, query);
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Рассылка своей группе',
    description:
      'Составляет и сразу отправляет сообщение действующему составу своей группы ' +
      '(ТЗ 5.4). Группа должна быть одной из тех, что ведёт вызывающий, иначе 422. ' +
      'Отвечает `202 Accepted`: доставка идёт фоном через очередь. Студент без адреса ' +
      'канала попадает в рассылку строкой `SKIPPED`, а не выпадает молча; текст ' +
      'поддерживает подстановку `{{firstName}}`/`{{lastName}}`.',
  })
  @ApiDataResponse(MailingSendResultDto, {
    status: HttpStatus.ACCEPTED,
    description: 'Задачи поставлены в очередь',
  })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SendGroupMailingDto,
  ): Promise<MailingSendResultDto> {
    return this.mailings.sendGroupMailing(user.accountId, dto);
  }
}
