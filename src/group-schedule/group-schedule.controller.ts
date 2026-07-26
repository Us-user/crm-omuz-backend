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
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import {
  CreateScheduleSlotDto,
  ScheduleSlotDto,
  ScheduleSlotQueryDto,
  ScheduleSlotRemovedDto,
  UpdateScheduleSlotDto,
} from './dto';
import { GroupScheduleService } from './group-schedule.service';

/**
 * Расписание группы (ТЗ 5.5). Маршруты вложены в группу: слот не существует
 * отдельно от неё, и адрес сам подтверждает, о каком расписании речь.
 *
 * Просмотр закрыт правом на группы, изменения — отдельным `ManageSchedule`:
 * видеть, когда занимается группа, нужно всем, кто с ней работает, а ставить
 * занятия в аудитории — не всем.
 *
 * Общий календарь всех групп (`GET /timetable`, ТЗ 5.10) собирается из этих же
 * слотов и появится в Фазе 10 — он агрегат, а не часть карточки группы.
 */
@ApiTags('Groups')
@ApiBearerAuth('access-token')
@Controller('groups/:groupId/schedule')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class GroupScheduleController {
  constructor(private readonly schedule: GroupScheduleService) {}

  @Get()
  @RequirePermission('Permission.Groups.Views')
  @ApiOperation({
    summary: 'Расписание группы',
    description:
      'Постраничный список занятий с аудиторией и ментором, по умолчанию в порядке ' +
      '«день недели, время». Слот повторяется еженедельно, пока идёт обучение группы. ' +
      'Фильтры `dayOfWeek`, `roomId`, `mentorId`; поиск `search` — по названию аудитории ' +
      'и имени ментора.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiPaginatedResponse(ScheduleSlotDto, { description: 'Занятия группы' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findAll(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Query() query: ScheduleSlotQueryDto,
  ): Promise<Paginated<ScheduleSlotDto>> {
    return this.schedule.findAll(groupId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Groups.ManageSchedule')
  @ApiOperation({
    summary: 'Добавление занятия в расписание',
    description:
      'Аудитория должна быть из филиала группы, ментор — из числа менторов группы (иначе 422). ' +
      'Пересечение по времени с занятием той же группы, той же аудитории или того же ментора — 409.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiDataResponse(ScheduleSlotDto, {
    description: 'Занятие добавлено',
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
  create(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() dto: CreateScheduleSlotDto,
  ): Promise<ScheduleSlotDto> {
    return this.schedule.create(groupId, dto);
  }

  @Put(':slotId')
  @RequirePermission('Permission.Groups.ManageSchedule')
  @ApiOperation({
    summary: 'Правка занятия',
    description:
      'Не переданное поле остаётся прежним. Пустая строка в `roomId` или `mentorId` ' +
      'убирает аудиторию или ментора из занятия. Проверки идут по итоговому состоянию слота.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiParam({ name: 'slotId', format: 'uuid' })
  @ApiDataResponse(ScheduleSlotDto, { description: 'Занятие изменено' })
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
    @Param('slotId', ParseUUIDPipe) slotId: string,
    @Body() dto: UpdateScheduleSlotDto,
  ): Promise<ScheduleSlotDto> {
    return this.schedule.update(groupId, slotId, dto);
  }

  @Delete(':slotId')
  @RequirePermission('Permission.Groups.ManageSchedule')
  @ApiOperation({
    summary: 'Удаление занятия из расписания',
    description: 'Убирается только слот: аудитория и ментор остаются нетронутыми.',
  })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiParam({ name: 'slotId', format: 'uuid' })
  @ApiDataResponse(ScheduleSlotRemovedDto, { description: 'Занятие убрано из расписания' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  remove(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('slotId', ParseUUIDPipe) slotId: string,
  ): Promise<ScheduleSlotRemovedDto> {
    return this.schedule.remove(groupId, slotId);
  }
}
