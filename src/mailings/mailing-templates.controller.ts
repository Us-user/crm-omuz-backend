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
  CreateTemplateDto,
  TemplateDeletedDto,
  TemplateDto,
  TemplateQueryDto,
  UpdateTemplateDto,
} from './dto';
import { MailingTemplatesService } from './mailing-templates.service';

/**
 * Шаблоны сообщений (ТЗ 5.19: `GET/POST/PUT/DELETE /mailings/templates`).
 *
 * Отдельный контроллер, а не действия внутри контроллера рассылок: путь
 * `/mailings/templates` иначе конкурировал бы с `/mailings/{id}`, и порядок
 * объявления методов стал бы частью маршрутизации. В модуле он объявлен
 * **первым** — этим и задан приоритет.
 */
@ApiTags('Mailings')
@ApiBearerAuth('access-token')
@Controller('mailings/templates')
// Рассылки ведут сотрудники; студенту положен только просмотр своих данных
// (ТЗ 3.2). Конкретное действие проверяет право каталога.
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class MailingTemplatesController {
  constructor(private readonly templates: MailingTemplatesService) {}

  @Get()
  @RequirePermission('Permission.Mailings.Views')
  @ApiOperation({
    summary: 'Список шаблонов',
    description:
      'Постраничный список (ТЗ 5.19). `search` — по названию, заголовку и тексту. ' +
      'Фильтр `channel` отбирает шаблоны этого канала **и шаблоны без канала**: ' +
      'текст, не привязанный к каналу, годится любому — то же правило, что у купона ' +
      'с пустым набором курсов (0027).',
  })
  @ApiPaginatedResponse(TemplateDto, { description: 'Шаблоны' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: TemplateQueryDto): Promise<Paginated<TemplateDto>> {
    return this.templates.findAll(query);
  }

  @Get(':id')
  @RequirePermission('Permission.Mailings.Views')
  @ApiOperation({ summary: 'Карточка шаблона' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(TemplateDto, { description: 'Шаблон' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<TemplateDto> {
    return this.templates.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Mailings.ManageTemplates')
  @ApiOperation({
    summary: 'Создание шаблона',
    description:
      'Название уникально без учёта регистра (409). `channel` необязателен: ' +
      'текст, годный и для Telegram, и для SMS, не нужно заводить дважды.',
  })
  @ApiDataResponse(TemplateDto, { status: HttpStatus.CREATED, description: 'Шаблон создан' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
  )
  create(
    @Body() dto: CreateTemplateDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TemplateDto> {
    return this.templates.create(dto, user.accountId);
  }

  @Put(':id')
  @RequirePermission('Permission.Mailings.ManageTemplates')
  @ApiOperation({
    summary: 'Правка шаблона',
    description:
      'Не переданное поле остаётся прежним, пустая строка в `channel` снимает привязку ' +
      'к каналу. Правка **не переписывает уже составленные рассылки**: текст копируется ' +
      'в них снимком в момент составления.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(TemplateDto, { description: 'Обновлённый шаблон' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTemplateDto,
  ): Promise<TemplateDto> {
    return this.templates.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('Permission.Mailings.ManageTemplates')
  @ApiOperation({
    summary: 'Удаление шаблона',
    description:
      'Удаляется **и использованный** шаблон — осознанно иначе, чем филиал с записями ' +
      'или купон, обещанный лиду (409): рассылка хранит текст снимком и теряет только ' +
      'указатель на источник. Чтобы убрать шаблон из выбора, не трогая историю, ' +
      'переведите его в `INACTIVE`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(TemplateDeletedDto, { description: 'Шаблон удалён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<TemplateDeletedDto> {
    return this.templates.remove(id);
  }
}
