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
import type { Paginated } from '../common';
import { ApiDataResponse, ApiPaginatedResponse, ApiStandardErrors } from '../common';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { CreateFeedbackDto, FeedbackDeletedDto, FeedbackDto, FeedbackQueryDto } from './dto';
import { StudentFeedbackService } from './student-feedback.service';

/**
 * Обратная связь по студенту (ТЗ 5.3). Маршруты вложены в студента: заметка
 * не существует отдельно от того, о ком она написана.
 *
 * Просмотр закрыт правом на карточки студентов, добавление и удаление —
 * отдельным `Permission.Students.Feedback`: читать наблюдения нужно всем, кто
 * работает со студентами, а писать от лица центра — не всем (то же разделение,
 * что у менторов группы).
 */
@ApiTags('Students')
@ApiBearerAuth('access-token')
@Controller('students/:studentId/feedback')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class StudentFeedbackController {
  constructor(private readonly feedback: StudentFeedbackService) {}

  @Get()
  @RequirePermission('Permission.Students.Views')
  @ApiOperation({
    summary: 'Заметки о студенте',
    description:
      'Постраничная лента, свежие сверху. Фильтр `authorId` — заметки одного ' +
      'сотрудника, поиск `search` — по тексту.',
  })
  @ApiParam({ name: 'studentId', format: 'uuid' })
  @ApiPaginatedResponse(FeedbackDto, { description: 'Заметки о студенте' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findAll(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Query() query: FeedbackQueryDto,
  ): Promise<Paginated<FeedbackDto>> {
    return this.feedback.findAll(studentId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Students.Feedback')
  @ApiOperation({
    summary: 'Добавление заметки о студенте',
    description:
      'Автор берётся из токена — подписаться чужим именем нельзя. Оценки в заметке ' +
      'нет: успеваемость считается по журналу (ТЗ 5.8).',
  })
  @ApiParam({ name: 'studentId', format: 'uuid' })
  @ApiDataResponse(FeedbackDto, { description: 'Заметка добавлена', status: HttpStatus.CREATED })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  create(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Body() dto: CreateFeedbackDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<FeedbackDto> {
    return this.feedback.create(studentId, dto, actor.accountId);
  }

  @Delete(':feedbackId')
  @RequirePermission('Permission.Students.Feedback')
  @ApiOperation({
    summary: 'Удаление заметки',
    description:
      'Сверх перечня маршрутов ТЗ 5.3: без него ошибочно добавленную заметку нельзя ' +
      'было бы убрать. Правки заметки нет намеренно — исправленное задним числом ' +
      'наблюдение перестаёт быть тем, что видел автор.',
  })
  @ApiParam({ name: 'studentId', format: 'uuid' })
  @ApiParam({ name: 'feedbackId', format: 'uuid' })
  @ApiDataResponse(FeedbackDeletedDto, { description: 'Заметка удалена' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  remove(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Param('feedbackId', ParseUUIDPipe) feedbackId: string,
  ): Promise<FeedbackDeletedDto> {
    return this.feedback.remove(studentId, feedbackId);
  }
}
