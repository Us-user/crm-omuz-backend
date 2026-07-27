import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import { AccountTypeGuard, RequireAccountType } from '../auth';
import type { Paginated } from '../common';
import { ApiDataResponse, ApiPaginatedResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import {
  LeftCourseDto,
  LeftCoursesQueryDto,
  LeftCoursesStatsDto,
  LeftCoursesStatsQueryDto,
} from './dto';
import { LeftCoursesService } from './left-courses.service';

/**
 * Покинувшие курсы (ТЗ 5.12).
 *
 * Оба маршрута закрыты `Permission.LeftCourses.Views` — единственный код
 * раздела в каталоге (сессия 0005), и до сих пор он никем не требовался.
 * Отдельного права на статистику нет: это тот же отчёт другой формой, и делить
 * его надвое значило бы заводить право, которое некому и незачем выдавать
 * отдельно.
 *
 * Витрина только читает: уход оформляется сменой статуса в составе группы
 * (`POST /groups/{id}/students/change-status`), где причина обязательна
 * по ТЗ 5.5. Второй способ «отчислить» из отчёта по отчислениям был бы
 * вторым источником истины о том же событии.
 */
@ApiTags('Left courses')
@ApiBearerAuth('access-token')
@Controller('left-courses')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class LeftCoursesController {
  constructor(private readonly leftCourses: LeftCoursesService) {}

  @Get()
  @RequirePermission('Permission.LeftCourses.Views')
  @ApiOperation({
    summary: 'Покинувшие курсы',
    description:
      'Постраничный список уходов (ТЗ 5.12: «вид Students»). Строка — это **покинутый ' +
      'курс**, а не человек: у студента, ушедшего с двух курсов, здесь две строки, ' +
      'и у каждой своя причина, дата и ментор на момент ухода. Переведённые в другую ' +
      'группу сюда не попадают — перевод не является уходом с курса. `search` ищет ' +
      'по имени, фамилии, телефону и **причине ухода**. Период задаётся месяцами ' +
      '(`from`/`to`, включительно) и целиком необязателен.',
  })
  @ApiPaginatedResponse(LeftCourseDto, { description: 'Уходы с курсов' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: LeftCoursesQueryDto): Promise<Paginated<LeftCourseDto>> {
    return this.leftCourses.findAll(query);
  }

  @Get('stats')
  @RequirePermission('Permission.LeftCourses.Views')
  @ApiOperation({
    summary: 'Статистика оттока',
    description:
      'Помесячный график (ТЗ 5.12) и три разреза: по группам («вид Groups»), курсам ' +
      'и филиалам. Без параметров показывается последний год, считая текущий месяц. ' +
      'Месяцы без уходов остаются в ряду с нулём. Разреза по причине нет: причина — ' +
      'свободный текст, и группировка по ней дала бы столько «категорий», сколько ' +
      'было операторов. Период длиннее 60 месяцев отклоняется (400).',
  })
  @ApiDataResponse(LeftCoursesStatsDto, { description: 'Отток за период' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  stats(@Query() query: LeftCoursesStatsQueryDto): Promise<LeftCoursesStatsDto> {
    return this.leftCourses.stats(query);
  }
}
