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

import { AccountTypeGuard, RequireAccountType } from '../auth';
import type { Paginated } from '../common';
import { ApiDataResponse, ApiPaginatedResponse, ApiStandardErrors } from '../common';
// Прямой путь, а не barrel `../rbac`: тот реэкспортирует ещё и сервисы
// с репозиториями, а контроллеру нужен только декоратор.
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import {
  CreatedLeadDto,
  CreateLeadDto,
  LeadDeletedDto,
  LeadDto,
  LeadQueryDto,
  UpdateLeadDto,
} from './dto';
import { LeadsService } from './leads.service';

/**
 * Лиды и клиенты (ТЗ 5.7) — левый конец жизненного цикла из ТЗ 1.
 *
 * Перевод в студенты (`POST /leads/transfer`) и выгрузка (`GET /leads/export`)
 * идут отдельным куском: первый заводит профиль студента, вторая переиспользует
 * CSV-код выгрузки состава группы (0013).
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
