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
  CreateStudentDto,
  PromoteStudentDto,
  PromoteStudentResponseDto,
  StudentDeletedDto,
  StudentDto,
  StudentQueryDto,
  UpdateStudentDto,
} from './dto';
import { StudentPromotionService } from './student-promotion.service';
import { StudentsService } from './students.service';

/**
 * Студенты (ТЗ 5.3) — админ-сторона: список с фильтрами, карточка, форма
 * и перевод в сотрудники (ТЗ 3.1).
 *
 * Класс закрыт по типу аккаунта целиком: список и карточки студентов — не то,
 * что положено видеть самому студенту (ТЗ 3.2 — ему доступен просмотр **своих**
 * данных, и это будет отдельная выборка кабинета). Конкретное действие сверх
 * этого закрыто своим правом каталога (ТЗ 3.8).
 */
@ApiTags('Students')
@ApiBearerAuth('access-token')
@Controller('students')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class StudentsController {
  constructor(
    private readonly students: StudentsService,
    private readonly promotion: StudentPromotionService,
  ) {}

  @Get()
  @RequirePermission('Permission.Students.Views')
  @ApiOperation({
    summary: 'Список студентов',
    description:
      'Постраничный список с филиалом, аккаунтом и действующими группами каждого студента. ' +
      'Фильтры ТЗ 5.3: `status`, `groupId` («Group»), `courseId` («Course»), плюс `branchId` ' +
      '(ТЗ 3.3) и `hasAccount`. Поиск `search` — по имени, фамилии, телефону и email. ' +
      'Фильтры по группе и курсу смотрят только на действующие членства.',
  })
  @ApiPaginatedResponse(StudentDto, { description: 'Студенты' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: StudentQueryDto): Promise<Paginated<StudentDto>> {
    return this.students.findAll(query);
  }

  @Get(':id')
  @RequirePermission('Permission.Students.Views')
  @ApiOperation({ summary: 'Карточка студента' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(StudentDto, { description: 'Карточка студента' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<StudentDto> {
    return this.students.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Students.Create')
  @ApiOperation({
    summary: 'Создание студента',
    description:
      'Заводит профиль без логина: аккаунт по ТЗ 5.3 опционален и выдаётся отдельным ' +
      'действием «Invite». Телефон приводится к E.164 и уникален среди студентов (409), ' +
      'несуществующий филиал в теле — 422.',
  })
  @ApiDataResponse(StudentDto, { description: 'Студент создан', status: HttpStatus.CREATED })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  create(@Body() dto: CreateStudentDto): Promise<StudentDto> {
    return this.students.create(dto);
  }

  @Put(':id')
  @RequirePermission('Permission.Students.Update')
  @ApiOperation({
    summary: 'Правка карточки студента',
    description:
      'Не переданное поле остаётся прежним, пустая строка в необязательном поле очищает его. ' +
      'Статус можно поставить руками, но он пересчитывается при изменении состава групп — ' +
      'кроме `BLOCK`, который автоматика не перебивает.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(StudentDto, { description: 'Карточка изменена' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStudentDto,
  ): Promise<StudentDto> {
    return this.students.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('Permission.Students.Delete')
  @ApiOperation({
    summary: 'Удаление студента',
    description:
      'Только «чистого» профиля: студент с членствами в группах не удаляется (409) — ' +
      'вместе с ним пропали бы причины и даты ухода (ТЗ 5.12). Для «человек больше ' +
      'не учится» есть статусы «No Active» и «Block» (ТЗ 5.3: Block ≠ Delete). ' +
      'Аккаунт студента удаляется вместе с профилем: логин без профиля запрещён ТЗ 3.1.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(StudentDeletedDto, { description: 'Студент удалён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<StudentDeletedDto> {
    return this.students.remove(id);
  }

  @Post(':id/promote-to-employee')
  @HttpCode(HttpStatus.CREATED)
  // Тип аккаунта проверяется на классе (студент отсекается сразу, ТЗ 3.2),
  // право — здесь: оно отвечает за конкретное действие и проверяется
  // по актуальным данным БД (ТЗ 3.8).
  @RequirePermission('Permission.Students.Promote')
  @ApiOperation({
    summary: 'Перевод студента в сотрудники',
    description:
      'Выпускник становится сотрудником (ТЗ 3.1). Логин не меняется: аккаунт тот же, ' +
      'меняется только его тип. Профиль студента остаётся вместе с учебной историей, ' +
      'а сотрудник получает ссылку на него в `formerStudentId`. ' +
      'Все сессии аккаунта гасятся — войти нужно заново, чтобы получить токены нового типа. ' +
      'Требует права `Permission.Students.Promote`. Позиции переведённому сотруднику ' +
      'назначаются отдельно — до этого прав у него нет.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Идентификатор профиля студента' })
  @ApiDataResponse(PromoteStudentResponseDto, {
    description: 'Профиль сотрудника создан',
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
  promoteToEmployee(
    // Идентификатор проверяется пайпом: строка не-UUID дошла бы до Prisma
    // и вернулась ошибкой БД (500) вместо честного 400.
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PromoteStudentDto,
  ): Promise<PromoteStudentResponseDto> {
    return this.promotion.promoteToEmployee(id, dto);
  }
}
