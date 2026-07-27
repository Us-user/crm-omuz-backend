import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import type { AuthenticatedUser } from '../auth';
import { AccountTypeGuard, CurrentUser, RequireAccountType } from '../auth';
import type { Paginated } from '../common';
import { ApiDataResponse, ApiPaginatedResponse, ApiStandardErrors } from '../common';
import {
  MeGroupDto,
  MeGroupQueryDto,
  MeProfileDto,
  MeScheduleQueryDto,
  MeScheduleSlotDto,
} from './dto';
import { StudentCabinetService } from './student-cabinet.service';

/**
 * Кабинет студента (ТЗ 5.3: «только просмотр»).
 *
 * Первый контур проекта, доступный **студенту**: всё остальное закрыто
 * `@RequireAccountType(EMPLOYEE)`. Адрес `/me` выбран отдельным от `/students/{id}`
 * намеренно — студенту нужны не те же выборки с фильтром, а другие: «мои группы»
 * это членства с курсом и менторами, а не строка списка админ-стороны.
 * Заодно ни один уже написанный и покрытый тестами эндпоинт не пришлось ветвить
 * по типу вызывающего.
 *
 * Прав каталога (`@RequirePermission`) здесь нет и быть не может: права даются
 * позициями, а позиции есть только у сотрудников (ТЗ 3.2), — guard прав отклонял
 * бы студента всегда. Доступ ограничивает тип аккаунта, а «своё» обеспечивается
 * тем, что профиль выводится из токена, а не из пути.
 *
 * Сотрудник получает здесь 403: это кабинет студента, а витрина сотрудника
 * (ТЗ 5.4) появится вместе с его профилем в Фазе 6.
 */
@ApiTags('Student cabinet')
@ApiBearerAuth('access-token')
@Controller('me')
@RequireAccountType(AccountType.STUDENT)
@UseGuards(AccountTypeGuard)
export class StudentCabinetController {
  constructor(private readonly cabinet: StudentCabinetService) {}

  @Get()
  @ApiOperation({
    summary: 'Свой профиль',
    description:
      'Профиль студента, вошедшего в систему (ТЗ 5.3: кабинет — «свой профиль»). ' +
      'Идентификатор в запросе не участвует: профиль выводится из токена. ' +
      'Заметок администратора (`notes`), заметок сотрудников (Feedback) и данных ' +
      'аккаунта здесь нет — это внутренние данные центра о человеке.',
  })
  @ApiDataResponse(MeProfileDto, { description: 'Профиль студента' })
  @ApiStandardErrors(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
  profile(@CurrentUser() user: AuthenticatedUser): Promise<MeProfileDto> {
    return this.cabinet.profile(user.accountId);
  }

  @Get('groups')
  @ApiOperation({
    summary: 'Свои группы',
    description:
      'Постраничный список членств с курсом, филиалом и менторами каждой группы ' +
      '(ТЗ 5.3: кабинет — «свои группы»). Закрытые членства остаются в списке: ' +
      'это учебная история. `status=ACTIVE` оставит только те группы, где студент ' +
      'учится сейчас; поиск `search` — по названию группы и курса.',
  })
  @ApiPaginatedResponse(MeGroupDto, { description: 'Группы студента' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  groups(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MeGroupQueryDto,
  ): Promise<Paginated<MeGroupDto>> {
    return this.cabinet.groups(user.accountId, query);
  }

  @Get('schedule')
  @ApiOperation({
    summary: 'Своё расписание',
    description:
      'Занятия групп, в которых студент учится сейчас (ТЗ 5.3: кабинет — «расписание»). ' +
      'Слот повторяется еженедельно: это «понедельник, 10:00–12:00», а не дата — ' +
      'разворот в календарь Day/Week/Month (ТЗ 5.10) появится с общим `/timetable`. ' +
      'Расписание покинутых групп сюда не попадает. Фильтр `groupId` действует ' +
      'в пределах своих действующих групп: чужая или несуществующая — 422.',
  })
  @ApiPaginatedResponse(MeScheduleSlotDto, { description: 'Занятия студента' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  schedule(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MeScheduleQueryDto,
  ): Promise<Paginated<MeScheduleSlotDto>> {
    return this.cabinet.schedule(user.accountId, query);
  }
}
