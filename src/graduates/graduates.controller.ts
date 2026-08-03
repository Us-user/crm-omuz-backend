import {
  Body,
  Controller,
  Delete,
  Get,
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
  ApiExtraModels,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { AccountType } from '@prisma/client';
import type { Response } from 'express';

import type { AuthenticatedUser } from '../auth';
import { AccountTypeGuard, CurrentUser, RequireAccountType } from '../auth';
import type { Paginated } from '../common';
import { ApiDataResponse, ApiPaginatedResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import {
  GraduateDto,
  GraduateEmploymentCountsDto,
  GraduatesQueryDto,
  IssueCertificateDto,
  UpdateGraduateDto,
} from './dto';
import { GraduatesService } from './graduates.service';

/**
 * Выпускники (ТЗ 5.11).
 *
 * Записи здесь не создаются: выпуск делает автовыпуск при переводе группы
 * курса с «Is last course» в статус `FINISHED` (`PUT /groups/{id}`). Второй
 * способ «выпустить» был бы вторым источником истины о том же событии — то же
 * решение, что у витрины покинувших курсы, где нет отчисления (0025).
 *
 * Права разведены на три: смотреть (`Views`), править карточку (`Update`)
 * и выдавать сертификат (`Certificate`). Все три лежат в каталоге с сессии 0005
 * и до сих пор никем не требовались. Выдача документа — не то же самое, что
 * правка места работы, и разрешать их вместе не стоит.
 */
@ApiTags('Graduates')
@ApiBearerAuth('access-token')
@Controller('graduates')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class GraduatesController {
  constructor(private readonly graduates: GraduatesService) {}

  @Get()
  @RequirePermission('Permission.Graduates.Views')
  @ApiOperation({
    summary: 'Выпускники',
    description:
      'Постраничный список выпусков (ТЗ 5.11: «виды Students/Groups»). Строка — это ' +
      '**выпуск с курса**, а не человек: закончив «Frontend», студент может пойти ' +
      'на «Backend» и выпуститься второй раз. Счётчики трудоустройства считаются ' +
      'по всему отобранному набору и уходят в `meta.employment` — они одни на все ' +
      'страницы. `search` ищет по имени, фамилии, телефону, месту работы и номеру ' +
      'сертификата. Период выпуска задаётся месяцами (`from`/`to`, включительно) ' +
      'и необязателен.',
  })
  @ApiExtraModels(GraduateEmploymentCountsDto)
  @ApiPaginatedResponse(GraduateDto, {
    description: 'Выпускники; счётчики трудоустройства — в `meta.employment`',
    meta: {
      employment: {
        $ref: getSchemaPath(GraduateEmploymentCountsDto),
        description: 'Счётчики трудоустройства по всему отобранному набору (ТЗ 5.11).',
      },
    },
  })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: GraduatesQueryDto): Promise<Paginated<GraduateDto>> {
    return this.graduates.findAll(query);
  }

  @Get(':id')
  @RequirePermission('Permission.Graduates.Views')
  @ApiOperation({ summary: 'Карточка выпускника' })
  @ApiDataResponse(GraduateDto, { description: 'Выпускник' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<GraduateDto> {
    return this.graduates.findOne(id);
  }

  @Put(':id')
  @RequirePermission('Permission.Graduates.Update')
  @ApiOperation({
    summary: 'Правка карточки выпускника',
    description:
      'Правятся только те поля, которые система не выводит сама: трудоустройство, ' +
      'место работы и дата выпуска. **`points` и `level` не правятся** — это снимок ' +
      'общего балла на момент выпуска (ТЗ 5.8), и правка руками сделала бы «за что ' +
      'выдан сертификат» ничем не подтверждённым. Сертификат выдаётся отдельным ' +
      'действием под своим правом.',
  })
  @ApiDataResponse(GraduateDto, { description: 'Обновлённая карточка' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGraduateDto,
  ): Promise<GraduateDto> {
    return this.graduates.update(id, dto);
  }

  @Post(':id/certificate')
  @RequirePermission('Permission.Graduates.Certificate')
  @ApiOperation({
    summary: 'Выдача сертификата',
    description:
      'Фиксирует серийный номер и дату выдачи (ТЗ 5.11, 3.7). Номер приходит извне ' +
      'и уникален по всему центру (409 на занятый): своей нумерации у системы нет, ' +
      'и придумывать её значило бы зашить в данные схему, которой ТЗ не задаёт. ' +
      'Повторная выдача — 409: снимите прежнюю, если номер нужно изменить. Сам PDF ' +
      'генерируется в Фазе 12 (`GET /graduates/{id}/certificate/export`).',
  })
  @ApiDataResponse(GraduateDto, { status: HttpStatus.CREATED, description: 'Сертификат выдан' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  issueCertificate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IssueCertificateDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GraduateDto> {
    return this.graduates.issueCertificate(id, dto, user.accountId);
  }

  @Delete(':id/certificate')
  @RequirePermission('Permission.Graduates.Certificate')
  @ApiOperation({
    summary: 'Снятие выдачи сертификата',
    description:
      'Сверх перечня маршрутов ТЗ 5.11 — прямое следствие правила «повторная выдача — ' +
      '409»: без снятия ошибочный номер остался бы навсегда, а вместе с ним занятым ' +
      'и сам номер. Право то же, что у выдачи.',
  })
  @ApiDataResponse(GraduateDto, { description: 'Выдача снята' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  revokeCertificate(@Param('id', ParseUUIDPipe) id: string): Promise<GraduateDto> {
    return this.graduates.revokeCertificate(id);
  }

  @Get(':id/certificate/export')
  @RequirePermission('Permission.Graduates.Certificate')
  @ApiOperation({ summary: 'Выгрузка сертификата выпускника в формате PDF (ТЗ 3.7, 5.11)' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  async exportCertificate(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const pdf = await this.graduates.exportCertificate(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="certificate_${id}.pdf"`);
    res.send(pdf);
  }
}
