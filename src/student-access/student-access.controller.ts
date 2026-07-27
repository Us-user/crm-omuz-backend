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

import type { AuthenticatedUser } from '../auth';
import { AccountTypeGuard, CurrentUser, RequireAccountType } from '../auth';
import { ApiDataResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { BlockStudentDto, InviteStudentDto, StudentBlockedDto, StudentInvitedDto } from './dto';
import { StudentAccessService } from './student-access.service';

/**
 * Доступ студента в систему (ТЗ 5.3): действия «Block» и «Invite» с карточки.
 *
 * Маршруты вложены в студента — оба действия не существуют отдельно от него.
 * Класс закрыт по типу аккаунта целиком: раздавать и отбирать доступ студенту
 * не положено (ТЗ 3.2), а конкретное действие закрыто своим правом каталога.
 */
@ApiTags('Students')
@ApiBearerAuth('access-token')
@Controller('students/:id')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class StudentAccessController {
  constructor(private readonly access: StudentAccessService) {}

  @Post('block')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('Permission.Students.Block')
  @ApiOperation({
    summary: 'Блокировка и разблокировка студента',
    description:
      'ТЗ 5.3: «Block — блок входа, обратимо, ≠ Delete». Одной транзакцией ставит ' +
      '`Student.status = BLOCK` и `Account.status = BLOCKED`, а живые сессии гасит — ' +
      'обновить токены заблокированный уже не сможет (выданный ранее access-токен ' +
      'доживёт свой час). `blocked: false` возвращает доступ и восстанавливает статус ' +
      'профиля по членствам в группах: учится — «Active», прошёл курс — «Finished», ' +
      'ушёл — «No Active». Студент без логина блокируется тоже — блокируется профиль.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(StudentBlockedDto, { description: 'Доступ изменён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  blockStudent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BlockStudentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<StudentBlockedDto> {
    return this.access.block(id, dto, actor.accountId);
  }

  @Post('invite')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Students.Invite')
  @ApiOperation({
    summary: 'Приглашение студента (выдача логина)',
    description:
      'ТЗ 5.3: аккаунт студента опционален и выдаётся действием «Invite». Логином ' +
      'становится контактный телефон карточки, пароль система не придумывает: аккаунт ' +
      'закрывается непригодным секретом, а студенту уходит письмо с одноразовым кодом ' +
      '(6 цифр, ~10 минут). Пароль он задаёт сам через `POST /auth/password/reset`. ' +
      'Повторное приглашение — 409: логин уже есть, а забытый пароль восстанавливается ' +
      'через `POST /auth/password/forgot`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(StudentInvitedDto, {
    description: 'Аккаунт создан, письмо отправлено',
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
  inviteStudent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InviteStudentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<StudentInvitedDto> {
    return this.access.invite(id, dto, actor.accountId);
  }
}
