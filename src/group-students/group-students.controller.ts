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
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import {
  AddGroupStudentsDto,
  ChangeGroupStudentsStatusDto,
  ExportGroupStudentsQueryDto,
  GroupStudentDto,
  GroupStudentQueryDto,
  GroupStudentRemovedDto,
  GroupStudentsAddedDto,
  GroupStudentsImportedDto,
  GroupStudentsStatusChangedDto,
  GroupStudentsTransferredDto,
  ImportGroupStudentsDto,
  TransferGroupStudentsDto,
} from './dto';
import { GroupStudentsService } from './group-students.service';

/**
 * Состав группы (ТЗ 5.5). Маршруты вложены в группу: членство не существует
 * отдельно от неё, и адрес сам подтверждает, о какой группе речь.
 *
 * Просмотр закрыт правом на группы, изменения — отдельным `ManageStudents`:
 * видеть состав нужно всем, кто работает с группами, а зачислять и переводить —
 * не всем. У выгрузки и импорта свои права (`Export`/`Import`): выгрузка
 * телефонов всей группы — это вынос персональных данных за пределы системы,
 * и разрешать его вместе с просмотром экрана не стоит.
 */
@ApiTags('Groups')
@ApiBearerAuth('access-token')
@Controller('groups/:groupId/students')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class GroupStudentsController {
  constructor(private readonly students: GroupStudentsService) {}

  @Get()
  @RequirePermission('Permission.Groups.Views')
  @ApiOperation({
    summary: 'Состав группы',
    description:
      'Постраничный список с профилем каждого студента. Фильтр `status` — статус ' +
      'участия в группе (`LEFT` даёт секцию «Left course» из ТЗ 5.5), поиск `search` — ' +
      'по имени, фамилии и телефону студента. Закрытые членства из списка не пропадают: ' +
      'состав группы — это её история.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiPaginatedResponse(GroupStudentDto, { description: 'Состав группы' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findAll(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Query() query: GroupStudentQueryDto,
  ): Promise<Paginated<GroupStudentDto>> {
    return this.students.findAll(groupId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Groups.ManageStudents')
  @ApiOperation({
    summary: 'Зачисление студентов в группу',
    description:
      'Пачкой и одной транзакцией. Несуществующий студент в списке — 422 (перечисляются ' +
      'только недостающие), уже зачисленный — 409. Студент не может одновременно учиться ' +
      'в двух группах одного курса (409), а на разных курсах — может. Вернувшийся в группу ' +
      'занимает прежнюю строку: причина и дата прошлого ухода снимаются.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiDataResponse(GroupStudentsAddedDto, {
    description: 'Студенты зачислены',
    status: HttpStatus.CREATED,
  })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  add(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() dto: AddGroupStudentsDto,
  ): Promise<GroupStudentsAddedDto> {
    return this.students.add(groupId, dto);
  }

  @Get('export')
  @RawResponse()
  @RequirePermission('Permission.Groups.Export')
  @ApiOperation({
    summary: 'Выгрузка состава группы в CSV',
    description:
      'ТЗ 5.5: «Import/Export». Отдаётся файл, а не `{ data }`: `text/csv` с BOM — ' +
      'Excel под Windows иначе читает UTF-8 как cp1251. Выгружается весь отобранный ' +
      'состав целиком (не страница), в порядке «фамилия, имя». Телефон стоит первой ' +
      'колонкой, поэтому файл принимается обратно импортом без правки.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiProduces('text/csv')
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'CSV с составом группы',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  async exportCsv(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Query() query: ExportGroupStudentsQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const file = await this.students.exportCsv(groupId, query);

    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    // Два имени по RFC 6266: ASCII — для клиентов, не понимающих `filename*`,
    // кириллическое — для всех остальных. Без второго файл сохранялся бы
    // с именем вида «__________.csv».
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.asciiFileName}"; ` +
        `filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );

    return file.content;
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('Permission.Groups.Import')
  @ApiOperation({
    summary: 'Импорт состава группы из CSV',
    description:
      'ТЗ 5.5: «Import/Export». Импорт **зачисляет уже заведённых** студентов: ' +
      'связь ищется по телефону (`Student.phone` уникален), профили не создаются. ' +
      'Файл применяется целиком или не применяется вовсе: любая плохая строка — ' +
      '422 со списком номеров строк и причин, в БД при этом не записано ничего.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiDataResponse(GroupStudentsImportedDto, { description: 'Файл принят, студенты зачислены' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  importCsv(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() dto: ImportGroupStudentsDto,
  ): Promise<GroupStudentsImportedDto> {
    return this.students.importCsv(groupId, dto);
  }

  @Post('change-status')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('Permission.Groups.ManageStudents')
  @ApiOperation({
    summary: 'Массовая смена статуса участия',
    description:
      'ТЗ 5.5: «массовые Change status (с обязательной причиной = Reason)». Меняется ' +
      'статус членства в группе, а не `Student.status` из ТЗ 5.3. Причина обязательна ' +
      'при любом статусе, включая возврат в обучение. `TRANSFERRED` этим маршрутом ' +
      'не ставится (422) — для него есть `/transfer`.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiDataResponse(GroupStudentsStatusChangedDto, { description: 'Статус изменён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  changeStatus(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() dto: ChangeGroupStudentsStatusDto,
  ): Promise<GroupStudentsStatusChangedDto> {
    return this.students.changeStatus(groupId, dto);
  }

  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('Permission.Groups.ManageStudents')
  @ApiOperation({
    summary: 'Перевод студентов в другую группу',
    description:
      'ТЗ 5.5: «Transfer в другую группу». Прежнее членство закрывается статусом ' +
      '`TRANSFERRED` с причиной и датой, в группе назначения заводится действующее — ' +
      'одной транзакцией. Учебная история при этом остаётся: видно, из какой группы ' +
      'студент пришёл.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid', description: 'Группа, из которой переводят' })
  @ApiDataResponse(GroupStudentsTransferredDto, { description: 'Студенты переведены' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  transfer(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() dto: TransferGroupStudentsDto,
  ): Promise<GroupStudentsTransferredDto> {
    return this.students.transfer(groupId, dto);
  }

  @Delete(':studentId')
  @RequirePermission('Permission.Groups.ManageStudents')
  @ApiOperation({
    summary: 'Исключение студента из состава',
    description:
      'Удаляется само членство вместе с его историей — для зачисленных по ошибке. ' +
      'Настоящий уход из группы оформляется сменой статуса на `LEFT`: он должен ' +
      'остаться в отчёте по покинувшим курс (ТЗ 5.12). Профиль студента не трогается.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiParam({ name: 'studentId', format: 'uuid', description: 'Профиль студента' })
  @ApiDataResponse(GroupStudentRemovedDto, { description: 'Студент убран из состава' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  remove(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('studentId', ParseUUIDPipe) studentId: string,
  ): Promise<GroupStudentRemovedDto> {
    return this.students.remove(groupId, studentId);
  }
}
