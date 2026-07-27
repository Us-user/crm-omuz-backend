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
  CreateJournalWeekDto,
  JournalQueryDto,
  JournalWeekDeletedDto,
  JournalWeekDto,
  JournalWeekSummaryDto,
  MarkAllPresentDto,
  MarkedAllPresentDto,
  UpdateJournalWeekDto,
  WeekSubmittedDto,
} from './dto';
import { GroupJournalService } from './group-journal.service';

/**
 * Журнал группы / Progressbook (ТЗ 5.8). Маршруты вложены в группу: неделя
 * журнала не существует отдельно от неё.
 *
 * Просмотр закрыт `Permission.Journal.Views`, правка — `.Update`, финализация —
 * отдельным `.Submit`: «Отправить результат» блокирует неделю и начисляет коины,
 * то есть это не то же самое, что проставить отметку. Все три кода лежали
 * в каталоге с сессии 0005 и до сих пор никем не требовались.
 */
@ApiTags('Journal')
@ApiBearerAuth('access-token')
@Controller('groups/:groupId/journal')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class GroupJournalController {
  constructor(private readonly journal: GroupJournalService) {}

  @Get()
  @RequirePermission('Permission.Journal.Views')
  @ApiOperation({
    summary: 'Журнал группы: список недель',
    description:
      'ТЗ 5.8. Постранично, по умолчанию от первой недели к последней. У каждой ' +
      'недели — её учебные дни, признак финализации, число студентов с итогом ' +
      'и средний Sum («Average»). Сами клетки отдаёт карточка недели.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiPaginatedResponse(JournalWeekSummaryDto, { description: 'Недели журнала группы' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findAll(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Query() query: JournalQueryDto,
  ): Promise<Paginated<JournalWeekSummaryDto>> {
    return this.journal.findAll(groupId, query);
  }

  @Post('weeks')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Journal.Update')
  @ApiOperation({
    summary: 'Новая неделя журнала',
    description:
      'ТЗ 5.8: «NEW WEEK». Учебные дни задаёт оператор — расписание группы ' +
      'описывает план, а журнал фиксирует факт. Дни обязаны укладываться в семь ' +
      'суток от начала недели (400) и не могут принадлежать другой неделе группы ' +
      '(409). Номер недели назначает система. Итоги действующего состава ' +
      'заводятся сразу нулевыми.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiDataResponse(JournalWeekDto, { description: 'Неделя заведена', status: HttpStatus.CREATED })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  create(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() dto: CreateJournalWeekDto,
  ): Promise<JournalWeekDto> {
    return this.journal.create(groupId, dto);
  }

  @Get('weeks/:weekId')
  @RequirePermission('Permission.Journal.Views')
  @ApiOperation({
    summary: 'Неделя журнала целиком',
    description:
      'Сверх перечня маршрутов ТЗ 5.8: список недель не может нести все клетки ' +
      'сразу. Отдаётся таблица «студент × день» с посещаемостью и баллами за ДЗ, ' +
      'разложением итога (Σ приходов, Σ ДЗ, Exam, Bonus) и самим Sum. Список ' +
      'не постраничный: неделя — это один экран, а страница, обрезанная посередине ' +
      'состава, для работы не годится.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiParam({ name: 'weekId', format: 'uuid' })
  @ApiDataResponse(JournalWeekDto, { description: 'Неделя журнала' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('weekId', ParseUUIDPipe) weekId: string,
  ): Promise<JournalWeekDto> {
    return this.journal.findOne(groupId, weekId);
  }

  @Put('weeks/:weekId')
  @RequirePermission('Permission.Journal.Update')
  @ApiOperation({
    summary: 'Правка недели: дни, посещаемость, баллы, Bonus и Exam',
    description:
      'ТЗ 5.8. `days` заменяет набор учебных дней целиком (убранный день уносит ' +
      'свои отметки), `entries` и `results` — точечные правки клеток и ручных ' +
      'слагаемых. В клетке `null` снимает отметку, отсутствие поля её не трогает. ' +
      'Итоги пересчитываются той же транзакцией и всем студентам недели: убранный ' +
      'день меняет Sum каждому, кто в него приходил. Финализированная неделя ' +
      'не правится (422).',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiParam({ name: 'weekId', format: 'uuid' })
  @ApiDataResponse(JournalWeekDto, { description: 'Неделя обновлена' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  update(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('weekId', ParseUUIDPipe) weekId: string,
    @Body() dto: UpdateJournalWeekDto,
  ): Promise<JournalWeekDto> {
    return this.journal.update(groupId, weekId, dto);
  }

  @Post('weeks/:weekId/mark-all-present')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('Permission.Journal.Update')
  @ApiOperation({
    summary: 'Отметить всех присутствующими',
    description:
      'ТЗ 5.8. Заполняются только **неотмеченные** клетки действующего состава: ' +
      'уже проставленные отметки, включая пропуски, кнопка не переписывает — ' +
      'восстановить их было бы неоткуда. Без `date` действие охватывает все дни ' +
      'недели, с датой — один день.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiParam({ name: 'weekId', format: 'uuid' })
  @ApiDataResponse(MarkedAllPresentDto, { description: 'Клетки заполнены' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  markAllPresent(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('weekId', ParseUUIDPipe) weekId: string,
    @Body() dto: MarkAllPresentDto,
  ): Promise<MarkedAllPresentDto> {
    return this.journal.markAllPresent(groupId, weekId, dto);
  }

  @Post('weeks/:weekId/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('Permission.Journal.Submit')
  @ApiOperation({
    summary: 'Финализация недели («Отправить результат»)',
    description:
      'ТЗ 5.8: неделя блокируется, коины начисляются автоматически по итогу ' +
      '(ТЗ 5.9: ≥100 → 5, 90–99 → 4, 85–89 → 2, <85 → 0), Директору собирается ' +
      'отчёт — всё одной транзакцией. Повторная финализация — 409; неделя ' +
      'без учебных дней не финализируется (422). Доставка отчёта в Telegram/почту ' +
      'появится с уведомлениями Фазы 11: сейчас он возвращается в ответе и пишется ' +
      'в лог приложения.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiParam({ name: 'weekId', format: 'uuid' })
  @ApiDataResponse(WeekSubmittedDto, { description: 'Неделя финализирована' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  submit(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('weekId', ParseUUIDPipe) weekId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<WeekSubmittedDto> {
    return this.journal.submit(groupId, weekId, actor.accountId);
  }

  @Delete('weeks/:weekId')
  @RequirePermission('Permission.Journal.Update')
  @ApiOperation({
    summary: 'Удаление недели',
    description:
      'Сверх перечня маршрутов ТЗ 5.8: без него неделя, заведённая по ошибке, ' +
      'навсегда искажала бы общий балл студента — он считается как среднее Sum ' +
      'по всем неделям. Финализированная неделя не удаляется (422): по её итогам ' +
      'уже выданы коины, а списание запрещено (ТЗ 5.9).',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiParam({ name: 'weekId', format: 'uuid' })
  @ApiDataResponse(JournalWeekDeletedDto, { description: 'Неделя удалена' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  remove(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('weekId', ParseUUIDPipe) weekId: string,
  ): Promise<JournalWeekDeletedDto> {
    return this.journal.remove(groupId, weekId);
  }
}
