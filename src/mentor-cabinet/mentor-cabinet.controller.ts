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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import type { AuthenticatedUser } from '../auth';
import { AccountTypeGuard, CurrentUser, RequireAccountType } from '../auth';
import {
  AvansQueryDto,
  AvansRequestCancelledDto,
  AvansRequestDto,
  CreateAvansRequestDto,
} from '../avans/dto';
import type { Paginated } from '../common';
import { ApiDataResponse, ApiPaginatedResponse, ApiStandardErrors } from '../common';
import {
  MentorCourseDto,
  MentorCourseQueryDto,
  MentorGroupDto,
  MentorGroupQueryDto,
  MentorMaterialDto,
  MentorMaterialQueryDto,
  MentorProfileDto,
  MentorTimetableQueryDto,
  MentorTimetableSlotDto,
} from './dto';
import { MentorCabinetService } from './mentor-cabinet.service';

/**
 * Кабинет ментора (ТЗ 5.4: «Профиль ментора … Меню: Profile, Groups, Material,
 * Timetable, Courses, SMS mailings»).
 *
 * Второй контур «своё» в проекте. Адрес свой (`/mentor`), а не `/me`: тот занят
 * кабинетом студента (сессия 0017), и ветвить его по типу вызывающего — ровно
 * та ошибка, от которой сессия 0017 и уходила: забытая ветка открывает чужие
 * данные, а обнаруживается это не отказом, а инцидентом.
 *
 * Прав каталога (`@RequirePermission`) здесь нет. Кабинет отдаёт только то,
 * что и так принадлежит вызывающему, и «своё» обеспечивается тем, что профиль
 * выводится из токена, а не из пути. Обратная сторона: то, на что права нужны
 * (состав групп, стоимость курса, чужие заявки на аванс), кабинет не показывает.
 *
 * Студент получает здесь 403 — как сотрудник на `/me`.
 */
@ApiTags('Mentor cabinet')
@ApiBearerAuth('access-token')
@Controller('mentor')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class MentorCabinetController {
  constructor(private readonly cabinet: MentorCabinetService) {}

  @Get('profile')
  @ApiOperation({
    summary: 'Свой профиль, уровень и часовая ставка',
    description:
      'Профиль сотрудника, вошедшего в систему (ТЗ 5.4, раздел «Profile»), вместе ' +
      'с уровнем ментора и часовой ставкой **текущего месяца** (ТЗ 5.4, 5.14). ' +
      'Идентификатор в запросе не участвует: профиль выводится из токена. ' +
      'Месяц назван в ответе явным полем — значение зависит от того, когда задан ' +
      'вопрос. `level: null` означает, что на этот месяц уровень не проставлен: ' +
      'предыдущий сюда не тянется (решение сессии 0021). Данных аккаунта здесь нет.',
  })
  @ApiDataResponse(MentorProfileDto, { description: 'Профиль сотрудника' })
  @ApiStandardErrors(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
  profile(@CurrentUser() user: AuthenticatedUser): Promise<MentorProfileDto> {
    return this.cabinet.profile(user.accountId);
  }

  @Get('groups')
  @ApiOperation({
    summary: 'Свои группы',
    description:
      'Постраничный список групп, где сотрудник числится ментором (ТЗ 5.4, раздел ' +
      '«Groups»), с курсом, филиалом, своей ролью (Teaching/Support) и «набрано/' +
      'вместимость». Фильтры `role` и `status`, поиск `search` — по названию группы ' +
      'и курса. Состава группы здесь нет: он требует права `Permission.Groups.Views`.',
  })
  @ApiPaginatedResponse(MentorGroupDto, { description: 'Группы под менторством' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  groups(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MentorGroupQueryDto,
  ): Promise<Paginated<MentorGroupDto>> {
    return this.cabinet.groups(user.accountId, query);
  }

  @Get('timetable')
  @ApiOperation({
    summary: 'Своё расписание',
    description:
      'Занятия групп, где сотрудник числится ментором (ТЗ 5.4, раздел «Timetable»). ' +
      'Отбор идёт **от менторства**, а не от ведущего на слоте: ведущий необязателен ' +
      '(сессия 0011), и выборка по нему отдала бы пустое расписание почти каждому. ' +
      'Кто ведёт лично, показывает поле `mine`; `onlyMine=true` оставит только свои ' +
      'занятия, `onlyMine=false` — только занятия коллег и слоты без ведущего. ' +
      'Слот повторяется еженедельно: это «понедельник, 10:00–12:00», а не дата. ' +
      'Фильтр `groupId` действует в пределах своих групп: чужая — 422.',
  })
  @ApiPaginatedResponse(MentorTimetableSlotDto, { description: 'Занятия ментора' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  timetable(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MentorTimetableQueryDto,
  ): Promise<Paginated<MentorTimetableSlotDto>> {
    return this.cabinet.timetable(user.accountId, query);
  }

  @Get('courses')
  @ApiOperation({
    summary: 'Свои курсы',
    description:
      'Курсы, по которым сотрудник ведёт хотя бы одну группу (ТЗ 5.4, раздел ' +
      '«Courses»), вместе со своими группами каждого курса. Стоимости курса ' +
      '(`fee`) здесь нет: цена относится к бухгалтерии (ТЗ 5.16), доступ к которой ' +
      'даётся правами, а кабинет прав не спрашивает.',
  })
  @ApiPaginatedResponse(MentorCourseDto, { description: 'Курсы ментора' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  courses(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MentorCourseQueryDto,
  ): Promise<Paginated<MentorCourseDto>> {
    return this.cabinet.courses(user.accountId, query);
  }

  @Get('materials')
  @ApiOperation({
    summary: 'Материалы своих групп',
    description:
      'Уроки программы, открытые группам сотрудника через «Show to group» (ТЗ 5.4, ' +
      'раздел «Material»; мультивыбор — ТЗ 5.6), вместе со ссылками на материалы. ' +
      'Это **не** вся программа курса: она читается `GET /courses/{id}/lessons` ' +
      'и требует права `Permission.Syllabus.Views`. Фильтры `groupId` (только своя ' +
      'группа, иначе 422), `courseId` и `type`; поиск — по названию и описанию урока.',
  })
  @ApiPaginatedResponse(MentorMaterialDto, { description: 'Материалы групп ментора' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  materials(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MentorMaterialQueryDto,
  ): Promise<Paginated<MentorMaterialDto>> {
    return this.cabinet.materials(user.accountId, query);
  }

  // ──────────────────────── Аванс о себе (ТЗ 5.4, 5.14) ──────────────────────

  @Get('avans')
  @ApiOperation({
    summary: 'Свои заявки на аванс',
    description:
      'Постраничный список своих заявок, свежие сверху (ТЗ 5.4: «Avans (заявка)»). ' +
      'Фильтр `status` и период по месяцу зарплаты (`from`/`to`, месяцы `YYYY-MM`, ' +
      'включительно). Рассмотрение (`review`) заполняется бухгалтерией — ТЗ 5.16, Фаза 9. ' +
      'Права каталога не требуется: заявки адресуются токеном, чужие сюда не попадают.',
  })
  @ApiPaginatedResponse(AvansRequestDto, { description: 'Свои заявки на аванс' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  avansRequests(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AvansQueryDto,
  ): Promise<Paginated<AvansRequestDto>> {
    return this.cabinet.avansRequests(user.accountId, query);
  }

  @Post('avans')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Подача заявки на аванс о себе',
    description:
      'Ментор подаёт заявку сам (ТЗ 5.4: «Avans (заявка)»; ТЗ 5.16 называет её ' +
      '«заявкой ментора»). Права `Permission.Avans.Create` не требуется: оно означает ' +
      '«завести заявку **любому** сотруднику», и выдав его каждому ментору, мы открыли ' +
      'бы подачу за коллег. Правила те же, что на админ-стороне (сессия 0022): ' +
      '**одна нерассмотренная заявка** — вторая `PENDING` даёт 409; месяц зарплаты ' +
      'обязателен, потому что одобренный аванс становится `Prepaid` месяца.',
  })
  @ApiDataResponse(AvansRequestDto, {
    description: 'Заявка подана и ждёт рассмотрения',
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
  createAvansRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAvansRequestDto,
  ): Promise<AvansRequestDto> {
    return this.cabinet.createAvansRequest(user.accountId, dto);
  }

  @Delete('avans/:avansId')
  @ApiOperation({
    summary: 'Отзыв своей заявки на аванс',
    description:
      'Отзывается **только** заявка в статусе `PENDING`: рассмотренная уже вошла ' +
      'в расчёт зарплаты месяца (422). Заявка ищется вместе с профилем вызывающего — ' +
      'чужую отозвать нельзя, она просто не находится (404).',
  })
  @ApiParam({ name: 'avansId', format: 'uuid' })
  @ApiDataResponse(AvansRequestCancelledDto, { description: 'Заявка отозвана' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  cancelAvansRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('avansId', ParseUUIDPipe) avansId: string,
  ): Promise<AvansRequestCancelledDto> {
    return this.cabinet.cancelAvansRequest(user.accountId, avansId);
  }
}
