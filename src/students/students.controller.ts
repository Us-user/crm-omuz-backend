import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import { AccountTypeGuard, RequireAccountType } from '../auth';
import { ApiDataResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac';
import { PromoteStudentDto, PromoteStudentResponseDto } from './dto';
import { StudentPromotionService } from './student-promotion.service';

/**
 * Модуль студентов (ТЗ 5.3) разворачивается в Фазе 4. Сейчас здесь только
 * перевод в сотрудники: он относится к сквозным требованиям по аккаунтам
 * (ТЗ 3.1) и нужен раньше, чем CRUD студентов.
 */
@ApiTags('Students')
@Controller('students')
export class StudentsController {
  constructor(private readonly promotion: StudentPromotionService) {}

  @Post(':id/promote-to-employee')
  @HttpCode(HttpStatus.CREATED)
  // Два уровня, а не один: тип аккаунта берётся из токена и отсекает студента
  // сразу (ТЗ 3.2 — ему доступен только просмотр своих данных), право проверяется
  // по актуальным данным БД и отвечает за конкретное действие (ТЗ 3.8).
  @RequireAccountType(AccountType.EMPLOYEE)
  @UseGuards(AccountTypeGuard)
  @RequirePermission('Permission.Students.Promote')
  @ApiBearerAuth('access-token')
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
