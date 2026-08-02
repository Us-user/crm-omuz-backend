import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import { AccountTypeGuard, RequireAccountType } from '../auth';
import { ApiDataResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { TimetableDto, TimetableQueryDto } from './dto';
import { TimetableService } from './timetable.service';

/**
 * Общее расписание центра (ТЗ 5.10).
 *
 * Закрыт `Permission.Timetable.Views` — единственный код раздела в каталоге
 * (сессия 0005), и до сих пор он никем не требовался. Правá на изменение здесь
 * нет и быть не может: календарь только читает, а занятия ставит расписание
 * группы под `Permission.Groups.ManageSchedule`.
 *
 * Это **админ-сторона**. У студента своё расписание в кабинете (`GET /me/schedule`,
 * сессия 0017), у ментора — своё (`GET /mentor/timetable`, сессия 0023); обе
 * выборки сужены принадлежностью и прав каталога не спрашивают. Ветвить этот
 * эндпоинт по типу вызывающего значило бы повторить ошибку, от которой сессия
 * 0017 уходила отдельными маршрутами: забытая ветка открывает чужие данные.
 */
@ApiTags('Timetable')
@ApiBearerAuth('access-token')
@Controller('timetable')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class TimetableController {
  constructor(private readonly timetable: TimetableService) {}

  @Get()
  @RequirePermission('Permission.Timetable.Views')
  @ApiOperation({
    summary: 'Календарь занятий всех групп',
    description:
      'Day/Week/Month (ТЗ 5.10). Еженедельные слоты групп разворачиваются в даты ' +
      'выбранного окна: занятие попадает в дату, если совпал день недели и дата лежит ' +
      'внутри сроков группы (незаполненная граница считается открытой). Отменённые ' +
      'группы в календарь не попадают вовсе — набор не состоялся; завершённые ' +
      'попадают, но только в пределах своих сроков. Дни без занятий остаются в ряду ' +
      'с пустым списком: ряд задаёт ось календаря, а не данные. Колонка «Type» и ' +
      'признак `held` берутся из журнала — у слота типа нет, потому что при ' +
      'еженедельном повторении каждый понедельник это другой день программы. ' +
      'Пагинации нет: окно ограничено месяцем по построению.',
  })
  @ApiDataResponse(TimetableDto, { description: 'Занятия окна по дням' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  find(@Query() query: TimetableQueryDto): Promise<TimetableDto> {
    return this.timetable.find(query);
  }
}
