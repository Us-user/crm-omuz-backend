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
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AccountType } from '@prisma/client';
import type { Response } from 'express';

import { AccountTypeGuard, RequireAccountType } from '../auth';
import type { Paginated } from '../common';
import { ApiDataResponse, ApiPaginatedResponse, ApiStandardErrors, RawResponse } from '../common';
// Прямой путь, а не barrel `../rbac`: тот реэкспортирует ещё и сервисы
// с репозиториями, а контроллеру нужен только декоратор.
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import {
  CreatedLeadDto,
  CreateLeadDto,
  ExportLeadsQueryDto,
  LeadDeletedDto,
  LeadDto,
  LeadQueryDto,
  LeadsTransferredDto,
  TransferLeadsDto,
  UpdateLeadDto,
} from './dto';
import { LeadsService } from './leads.service';

/**
 * Лиды и клиенты (ТЗ 5.7) — жизненный цикл из ТЗ 1 целиком: «Лид (реклама) →
 * Client (после пробного дня) → Студент».
 */
@ApiTags('Leads')
@ApiBearerAuth('access-token')
@Controller('leads')
// Маркетинговый контур ведут сотрудники; студенту положен только просмотр
// своих данных (ТЗ 3.2). Конкретное действие проверяет право каталога.
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  @RequirePermission('Permission.Leads.Views')
  @ApiOperation({
    summary: 'Список лидов и клиентов',
    description:
      'Постраничный список (ТЗ 5.7: «фильтры по датам/курсу»). `search` — по имени, ' +
      'фамилии, телефону, почте, источнику и UTM-кампании. Период `from`/`to` задаётся ' +
      'месяцами и относится к **дате обращения**; месяц, на который человек ' +
      'записывается, — отдельный фильтр `enrollMonth`, и путать их нельзя: ' +
      'обращение сентября вполне может записываться на ноябрь.',
  })
  @ApiPaginatedResponse(LeadDto, { description: 'Лиды и клиенты' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: LeadQueryDto): Promise<Paginated<LeadDto>> {
    return this.leads.findAll(query);
  }

  // Объявлен **до** `:id`: Nest сопоставляет маршруты в порядке объявления,
  // и ниже `export` уехал бы в параметр (`ParseUUIDPipe` ответил бы 400
  // на существующий эндпоинт).
  @Get('export')
  @RawResponse()
  @RequirePermission('Permission.Leads.Export')
  @ApiOperation({
    summary: 'Выгрузка лидов в CSV',
    description:
      'ТЗ 5.7: «Export». Отдаётся файл, а не `{ data }`: `text/csv` с BOM — Excel под ' +
      'Windows иначе читает UTF-8 как cp1251. Выгружается весь отобранный набор целиком ' +
      '(не страница), свежими обращениями сверху; фильтры те же, что у списка. ' +
      'Выгрузка контактов — вынос персональных данных за пределы системы, поэтому ' +
      'у неё своё право, а не `Views`.',
  })
  @ApiProduces('text/csv')
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'CSV с лидами',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  async exportCsv(
    @Query() query: ExportLeadsQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const file = await this.leads.exportCsv(query);

    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    // Два имени по RFC 6266: ASCII — для клиентов, не понимающих `filename*`,
    // кириллическое — для всех остальных (тот же приём, что в 0013).
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.asciiFileName}"; ` +
        `filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );

    return file.content;
  }

  @Get(':id')
  @RequirePermission('Permission.Leads.Views')
  @ApiOperation({ summary: 'Карточка лида' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(LeadDto, { description: 'Лид' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<LeadDto> {
    return this.leads.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Leads.Create')
  @ApiOperation({
    summary: 'Создание лида',
    description:
      'Телефон приводится к E.164, но **на занятость не проверяется**: один человек ' +
      'может обратиться дважды, и это два обращения, а не дубликат. Вместо отказа ' +
      'в ответ уходит `duplicatePhoneCount` — сколько прежних обращений с этим же ' +
      'номером уже есть. Несуществующий курс, купон или филиал в теле — 422.',
  })
  @ApiDataResponse(CreatedLeadDto, { status: HttpStatus.CREATED, description: 'Лид заведён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  create(@Body() dto: CreateLeadDto): Promise<CreatedLeadDto> {
    return this.leads.create(dto);
  }

  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('Permission.Leads.Transfer')
  @ApiOperation({
    summary: 'Перевод лидов в студенты',
    description:
      'ТЗ 5.7: «Transfer в студенты (bulk/по строке)» — режим «по строке» это список ' +
      'из одного элемента. Обращение при переводе **не удаляется**: оно хранит ссылку ' +
      'на заведённый профиль, иначе воронка потеряла бы тот конец, ради которого её ' +
      'считают (ТЗ 5.2). Если студент с таким телефоном уже есть, второй профиль ' +
      '**не заводится** — обращение привязывается к существующему (`action: "linked"`). ' +
      'Пачка применяется целиком: любая непереводимая строка — 422 с отчётом ' +
      '`{ leadId, reason }`, и не переведён при этом никто. В группу студент ' +
      'не зачисляется: это отдельное действие состава (`POST /groups/{id}/students`) ' +
      'со своими правилами.',
  })
  @ApiDataResponse(LeadsTransferredDto, { description: 'Обращения переведены' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  transfer(@Body() dto: TransferLeadsDto): Promise<LeadsTransferredDto> {
    return this.leads.transfer(dto);
  }

  @Put(':id')
  @RequirePermission('Permission.Leads.Update')
  @ApiOperation({
    summary: 'Правка лида',
    description:
      'Не переданное поле остаётся прежним, пустая строка очищает текст или снимает ' +
      'ссылку на курс, купон и филиал. Смена `type` на `CLIENT` проставляет дату ' +
      'перехода, возврат в `LEAD` её снимает — дату события ставит система, а не ' +
      'оператор. Телефон пустой строкой не очищается (400): он обязателен.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(LeadDto, { description: 'Обновлённый лид' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLeadDto): Promise<LeadDto> {
    return this.leads.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('Permission.Leads.Delete')
  @ApiOperation({
    summary: 'Удаление лида',
    description:
      'Ограничений нет — в отличие от филиалов, курсов и студентов. Лид чаще любой ' +
      'другой записи оказывается ошибочным (не тот номер, звонок оказался рекламой), ' +
      'и держать такие строки вечно значило бы засорять воронку. Это же законный ' +
      'способ освободить профиль студента, переведённого по ошибке.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(LeadDeletedDto, { description: 'Лид удалён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<LeadDeletedDto> {
    return this.leads.remove(id);
  }
}
