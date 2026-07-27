import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
  MentorLevelHistoryDto,
  MentorLevelHistoryQueryDto,
  MentorLevelHistoryRemovedDto,
  SetMentorLevelDto,
} from './dto';
import { EmployeeMentorLevelsService } from './employee-mentor-levels.service';

/**
 * Уровень сотрудника по месяцам (ТЗ 5.14: «история по месяцам → зарплата
 * по уровню месяца»). Маршруты вложены в сотрудника: запись не существует
 * отдельно от него, и адрес сам подтверждает, о ком речь.
 *
 * Просмотр закрыт `Permission.Mentors.Views`, изменения — `ManageLevels`:
 * видеть, на какой ступени человек, нужно всем, кто работает с менторами,
 * а двигать ступени — не всем. Оба кода лежат в каталоге с сессии 0005.
 */
@ApiTags('Employees')
@ApiBearerAuth('access-token')
@Controller('employees/:employeeId/mentor-levels')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class EmployeeMentorLevelsController {
  constructor(private readonly history: EmployeeMentorLevelsService) {}

  @Get()
  @RequirePermission('Permission.Mentors.Views')
  @ApiOperation({
    summary: 'Уровень сотрудника по месяцам',
    description:
      'Постраничная история со ступенью и её ставкой в каждом месяце, свежие сверху. ' +
      'Фильтры `from`/`to` (месяцы `YYYY-MM`, включительно) и `levelId`. ' +
      'Месяц, которого нет в истории, означает, что уровня в нём не было: ближайший ' +
      'предыдущий сюда не тянется.',
  })
  @ApiParam({ name: 'employeeId', format: 'uuid' })
  @ApiPaginatedResponse(MentorLevelHistoryDto, { description: 'История уровня по месяцам' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findAll(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: MentorLevelHistoryQueryDto,
  ): Promise<Paginated<MentorLevelHistoryDto>> {
    return this.history.findAll(employeeId, query);
  }

  @Put()
  @RequirePermission('Permission.Mentors.ManageLevels')
  @ApiOperation({
    summary: 'Простановка уровня на месяц',
    description:
      'Идемпотентно: на сотрудника в месяце ровно одна запись, поэтому повторный запрос ' +
      'меняет ступень месяца, а не заводит вторую строку. Несуществующая ступень — 422, ' +
      'выведенная из справочника (`INACTIVE`) — тоже 422: новым месяцам она не проставляется, ' +
      'но уже проставленная остаётся, иначе прошлые месяцы потеряли бы ставку.',
  })
  @ApiParam({ name: 'employeeId', format: 'uuid' })
  @ApiDataResponse(MentorLevelHistoryDto, { description: 'Уровень месяца задан' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  set(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: SetMentorLevelDto,
  ): Promise<MentorLevelHistoryDto> {
    return this.history.set(employeeId, dto);
  }

  @Delete(':month')
  @RequirePermission('Permission.Mentors.ManageLevels')
  @ApiOperation({
    summary: 'Снятие уровня с месяца',
    description:
      'Маршрута нет в перечне ТЗ 5.14, но без него ошибочно проставленный месяц нельзя ' +
      'было бы убрать: «уровня в этом месяце нет» — законное состояние, и вернуться ' +
      'в него надо чем-то. Месяц адресуется своим значением `YYYY-MM` — у записи это ' +
      'естественный ключ вместе с сотрудником.',
  })
  @ApiParam({ name: 'employeeId', format: 'uuid' })
  @ApiParam({ name: 'month', example: '2026-09', description: 'Месяц в формате YYYY-MM' })
  @ApiDataResponse(MentorLevelHistoryRemovedDto, { description: 'Уровень снят с месяца' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  remove(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('month') month: string,
  ): Promise<MentorLevelHistoryRemovedDto> {
    return this.history.remove(employeeId, month);
  }
}
