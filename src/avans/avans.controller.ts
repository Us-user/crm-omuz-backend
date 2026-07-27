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
import { AvansService } from './avans.service';
import {
  AvansQueryDto,
  AvansRequestCancelledDto,
  AvansRequestDto,
  CreateAvansRequestDto,
} from './dto';

/**
 * Заявки на аванс (ТЗ 5.14). Маршруты вложены в сотрудника: заявка не существует
 * отдельно от того, кому аванс, и адрес сам подтверждает, о ком речь.
 *
 * Просмотр закрыт `Permission.Avans.Views`, подача — `Permission.Avans.Create`:
 * видеть заявки нужно всем, кто работает с менторами, а заводить их — не всем.
 * Одобрение (`Permission.Avans.Approve`) относится к бухгалтерии и появится
 * в Фазе 9 вместе с `/accounting/avans/{id}/approve|deny` (ТЗ 5.16). Все три
 * кода лежат в каталоге с сессии 0005.
 */
@ApiTags('Employees')
@ApiBearerAuth('access-token')
@Controller('employees/:employeeId/avans')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class AvansController {
  constructor(private readonly avans: AvansService) {}

  @Get()
  @RequirePermission('Permission.Avans.Views')
  @ApiOperation({
    summary: 'Заявки сотрудника на аванс',
    description:
      'Постраничный список, свежие сверху. Фильтры `status` и период по месяцу ' +
      'зарплаты (`from`/`to`, месяцы `YYYY-MM`, включительно). Рассмотрение ' +
      '(`review`) заполняется бухгалтерией — ТЗ 5.16, Фаза 9.',
  })
  @ApiParam({ name: 'employeeId', format: 'uuid' })
  @ApiPaginatedResponse(AvansRequestDto, { description: 'Заявки на аванс' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findAll(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: AvansQueryDto,
  ): Promise<Paginated<AvansRequestDto>> {
    return this.avans.findAll(employeeId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Avans.Create')
  @ApiOperation({
    summary: 'Подача заявки на аванс',
    description:
      'Заявка заводится на сотрудника из адреса; автор берётся из токена — ' +
      'подать её от чужого имени нельзя. **Одна нерассмотренная заявка ' +
      'на сотрудника**: вторая `PENDING` — 409. Сотрудник, выведенный из штата ' +
      '(`INACTIVE`), новых заявок не подаёт — 422.',
  })
  @ApiParam({ name: 'employeeId', format: 'uuid' })
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
  create(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: CreateAvansRequestDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<AvansRequestDto> {
    return this.avans.create(employeeId, dto, actor.accountId);
  }

  @Delete(':avansId')
  @RequirePermission('Permission.Avans.Create')
  @ApiOperation({
    summary: 'Отзыв заявки на аванс',
    description:
      'Маршрута нет в перечне ТЗ 5.14, но без него ошибочная заявка осталась бы ' +
      'навсегда и, из-за правила «одна нерассмотренная», закрыла бы сотруднику ' +
      'подачу следующей. Отзывается **только** заявка в статусе `PENDING`: ' +
      'рассмотренная уже вошла в расчёт зарплаты месяца (422).',
  })
  @ApiParam({ name: 'employeeId', format: 'uuid' })
  @ApiParam({ name: 'avansId', format: 'uuid' })
  @ApiDataResponse(AvansRequestCancelledDto, { description: 'Заявка отозвана' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  remove(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('avansId', ParseUUIDPipe) avansId: string,
  ): Promise<AvansRequestCancelledDto> {
    return this.avans.remove(employeeId, avansId);
  }
}
