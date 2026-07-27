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
  CreateStudentParentDto,
  StudentParentDto,
  StudentParentLinkedDto,
  StudentParentQueryDto,
  StudentParentUnlinkedDto,
  UpdateStudentParentDto,
} from './dto';
import { StudentParentsService } from './student-parents.service';

/**
 * Родители и опекуны студента (ТЗ 4: Parent/Guardian).
 *
 * Маршрутов для родителей ТЗ не перечисляет, но каталог прав задаёт границы
 * разделом `Permission.Parents.*` (сессия 0005), и адрес взят вложенным
 * в студента: родитель попадает в систему из его карточки.
 *
 * Отдельного справочника `/parents` намеренно нет: запись родителя общая,
 * но находится по телефону из той же формы, а второй экран заставил бы
 * оператора делать два запроса вместо одного.
 */
@ApiTags('Students')
@ApiBearerAuth('access-token')
@Controller('students/:studentId/parents')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class StudentParentsController {
  constructor(private readonly parents: StudentParentsService) {}

  @Get()
  @RequirePermission('Permission.Parents.Views')
  @ApiOperation({
    summary: 'Родители и опекуны студента',
    description:
      'Постраничный список. Фильтр `relation` — степень родства, поиск `search` — ' +
      'по имени, фамилии и телефону. `childrenCount` больше единицы означает, что ' +
      'запись общая с другим студентом центра.',
  })
  @ApiParam({ name: 'studentId', format: 'uuid' })
  @ApiPaginatedResponse(StudentParentDto, { description: 'Родители студента' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findAll(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Query() query: StudentParentQueryDto,
  ): Promise<Paginated<StudentParentDto>> {
    return this.parents.findAll(studentId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Parents.Create')
  @ApiOperation({
    summary: 'Добавление родителя студенту',
    description:
      'Родитель узнаётся по телефону: если человек с таким номером уже заведён ' +
      '(например, вторым ребёнком или регистрацией), запись не дублируется, ' +
      'а привязывается — в ответе `created: false`. Пустые поля такой записи ' +
      'дозаполняются данными из запроса, заполненные не перезаписываются.',
  })
  @ApiParam({ name: 'studentId', format: 'uuid' })
  @ApiDataResponse(StudentParentLinkedDto, {
    description: 'Родитель добавлен студенту',
    status: HttpStatus.CREATED,
  })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  create(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Body() dto: CreateStudentParentDto,
  ): Promise<StudentParentLinkedDto> {
    return this.parents.create(studentId, dto);
  }

  @Put(':parentId')
  @RequirePermission('Permission.Parents.Update')
  @ApiOperation({
    summary: 'Правка родителя',
    description:
      'Правятся поля общей записи и степень родства с этим студентом. Изменения ' +
      'контактов видны и в карточках других детей этого родителя — их число ' +
      'возвращается в `childrenCount`.',
  })
  @ApiParam({ name: 'studentId', format: 'uuid' })
  @ApiParam({ name: 'parentId', format: 'uuid' })
  @ApiDataResponse(StudentParentDto, { description: 'Родитель изменён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  update(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Param('parentId', ParseUUIDPipe) parentId: string,
    @Body() dto: UpdateStudentParentDto,
  ): Promise<StudentParentDto> {
    return this.parents.update(studentId, parentId, dto);
  }

  @Delete(':parentId')
  @RequirePermission('Permission.Parents.Delete')
  @ApiOperation({
    summary: 'Отвязка родителя от студента',
    description:
      'Убирает родителя из карточки. Если детей в центре у него больше нет, запись ' +
      'удаляется целиком (`parentDeleted: true`): справочника родителей нет, и такая ' +
      'строка стала бы недостижимой. У родителя с другими детьми запись остаётся.',
  })
  @ApiParam({ name: 'studentId', format: 'uuid' })
  @ApiParam({ name: 'parentId', format: 'uuid' })
  @ApiDataResponse(StudentParentUnlinkedDto, { description: 'Родитель отвязан' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  remove(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Param('parentId', ParseUUIDPipe) parentId: string,
  ): Promise<StudentParentUnlinkedDto> {
    return this.parents.remove(studentId, parentId);
  }
}
