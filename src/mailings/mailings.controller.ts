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
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import type { AuthenticatedUser } from '../auth';
import { AccountTypeGuard, CurrentUser, RequireAccountType } from '../auth';
import type { Paginated } from '../common';
import { ApiDataResponse, ApiPaginatedResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import {
  CreateMailingDto,
  MailingDeletedDto,
  MailingDto,
  MailingQueryDto,
  MailingSendResultDto,
  NotificationDto,
  NotificationQueryDto,
  UpdateMailingDto,
} from './dto';
import { MailingsService } from './mailings.service';

/**
 * Рассылки (ТЗ 5.19: `GET/POST /mailings`, `GET /mailings/history`).
 *
 * Рассылка — документ: составляется черновиком, отправляется отдельным
 * действием и после этого не правится. Отправка **ставит задачи в очередь**
 * и отвечает `202 Accepted`: доставка тысяче человек не должна держать
 * HTTP-запрос (решение пользователя).
 */
@ApiTags('Mailings')
@ApiBearerAuth('access-token')
@Controller('mailings')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class MailingsController {
  constructor(private readonly mailings: MailingsService) {}

  @Get()
  @RequirePermission('Permission.Mailings.Views')
  @ApiOperation({
    summary: 'Список рассылок',
    description:
      'Постраничный список черновиков и отправленных (ТЗ 5.19). `search` — по заголовку ' +
      'и тексту, `sent` разделяет черновики и отправленные. Фильтра по **состоянию** ' +
      'рассылки нет намеренно: оно выводится из счётчиков доставок, и фильтр по нему ' +
      'потребовал бы подзапроса на каждую строку.',
  })
  @ApiPaginatedResponse(MailingDto, { description: 'Рассылки' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: MailingQueryDto): Promise<Paginated<MailingDto>> {
    return this.mailings.findAll(query);
  }

  // Объявлен **до** `@Get(':id')`: иначе `history` попал бы в параметр пути
  // и вернулся бы 400 «не UUID». Порядок методов внутри контроллера — часть
  // маршрутизации Nest.
  @Get('history')
  @RequirePermission('Permission.Mailings.Views')
  @ApiOperation({
    summary: 'История рассылок',
    description:
      'Отправленные рассылки со счётчиками доставок (ТЗ 5.19). Отличается от списка ' +
      'ровно одним — черновиков здесь нет; фильтр `sent` игнорируется.',
  })
  @ApiPaginatedResponse(MailingDto, { description: 'Отправленные рассылки' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findHistory(@Query() query: MailingQueryDto): Promise<Paginated<MailingDto>> {
    return this.mailings.findHistory(query);
  }

  @Get(':id')
  @RequirePermission('Permission.Mailings.Views')
  @ApiOperation({ summary: 'Карточка рассылки' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(MailingDto, { description: 'Рассылка' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<MailingDto> {
    return this.mailings.findOne(id);
  }

  @Get(':id/recipients')
  @RequirePermission('Permission.Mailings.Views')
  @ApiOperation({
    summary: 'Доставки рассылки',
    description:
      'Сверх перечня маршрутов ТЗ 5.19 — то, ради чего доставка хранится строкой ' +
      'на человека: «дошло ли до этого студента». Фильтр `status` отбирает упавшие; ' +
      '`search` — по имени и адресу. Счётчики всей рассылки — в `meta.deliveries` ' +
      '(они одни на все страницы, приём 0019).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiPaginatedResponse(NotificationDto, { description: 'Доставки' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findRecipients(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: NotificationQueryDto,
  ): Promise<Paginated<NotificationDto>> {
    return this.mailings.findRecipients(id, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Mailings.Create')
  @ApiOperation({
    summary: 'Составление рассылки',
    description:
      'Заводит **черновик** (ТЗ 5.19: «Составление (Title/Description/Template)»). ' +
      'Отправку делает отдельное действие. `templateId` подставляет заголовок и текст ' +
      '**снимком**; без шаблона оба поля обязательны (422). Группа обязательна ' +
      'при `audience = GROUP` и запрещена при остальных (422).',
  })
  @ApiDataResponse(MailingDto, { status: HttpStatus.CREATED, description: 'Черновик создан' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  create(
    @Body() dto: CreateMailingDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MailingDto> {
    return this.mailings.create(dto, user.accountId);
  }

  @Put(':id')
  @RequirePermission('Permission.Mailings.Update')
  @ApiOperation({
    summary: 'Правка черновика',
    description:
      'Только до отправки: отправленная рассылка — строка истории, и менять её текст ' +
      'задним числом значило бы расходиться с тем, что люди уже прочитали (422).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(MailingDto, { description: 'Обновлённый черновик' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMailingDto,
  ): Promise<MailingDto> {
    return this.mailings.update(id, dto);
  }

  @Post(':id/send')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('Permission.Mailings.Send')
  @ApiOperation({
    summary: 'Отправка рассылки',
    description:
      '«Send» из ТЗ 5.19. Аудитория вычисляется **в этот момент**, а не в день ' +
      'составления черновика, и застывает строками доставки — по одной на человека. ' +
      'Отвечает `202 Accepted`: доставка идёт фоном через очередь. Повторная отправка — ' +
      '422 (для упавших есть `retry`), пустая аудитория — 422 («отправлено никому» ' +
      'не состояние рассылки, а незамеченная ошибка). Получатель без адреса канала ' +
      'попадает в рассылку строкой `SKIPPED` с причиной, а не выпадает из неё молча.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
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
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MailingSendResultDto> {
    return this.mailings.send(id, user.accountId);
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('Permission.Mailings.Send')
  @ApiOperation({
    summary: 'Повтор незавершённых доставок',
    description:
      'Сверх перечня маршрутов ТЗ 5.19 и то, ради чего доставка хранится строкой ' +
      'на человека: временный отказ провайдера у двадцати получателей из тысячи ' +
      'не должен означать, что весь список получит сообщение по второму разу. ' +
      'Берутся `FAILED` **и `PENDING`** — вторые лечат доставку, зависшую из-за ' +
      'падения приложения между записью строк и постановкой задач; повторная задача ' +
      'безопасна, потому что обработчик берёт только `PENDING`. `SKIPPED` не берётся: ' +
      'у этих людей нет адреса, и повторять нечего, пока его не заполнят.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(MailingSendResultDto, {
    status: HttpStatus.ACCEPTED,
    description: 'Упавшие доставки возвращены в очередь',
  })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  retry(@Param('id', ParseUUIDPipe) id: string): Promise<MailingSendResultDto> {
    return this.mailings.retry(id);
  }

  @Delete(':id')
  @RequirePermission('Permission.Mailings.Delete')
  @ApiOperation({
    summary: 'Удаление черновика',
    description:
      'Сверх перечня маршрутов ТЗ 5.19: без него ошибочно составленная рассылка ' +
      'осталась бы в списке навсегда. **Отправленная не удаляется** (422) — это история ' +
      'того, что центр написал людям.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(MailingDeletedDto, { description: 'Черновик удалён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<MailingDeletedDto> {
    return this.mailings.remove(id);
  }
}
