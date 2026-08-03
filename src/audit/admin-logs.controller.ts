import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import { AccountTypeGuard, RequireAccountType } from '../auth';
import type { Paginated } from '../common';
import { ApiPaginatedResponse, ApiStandardErrors } from '../common';
// Прямой путь, а не barrel `../rbac`: тот реэкспортирует ещё и сервисы
// с репозиториями, а контроллеру нужен только декоратор.
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { AdminLogsService } from './admin-logs.service';
import { AuditLogDto, AuditLogQueryDto } from './dto';

/**
 * `Administration → Logs` (ТЗ 3.6, 5.15): журнал действий — кто, что, когда.
 *
 * Только чтение. Записи заводит перехватчик на каждом изменяющем запросе,
 * и другого способа их создать нет: журнал, в который можно дописать строку
 * запросом, не отвечал бы на вопрос «что здесь произошло на самом деле».
 */
@ApiTags('Administration')
@ApiBearerAuth('access-token')
@Controller('admin/logs')
// Журнал действий центра — не то, что положено видеть студенту (ТЗ 3.2).
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class AdminLogsController {
  constructor(private readonly logs: AdminLogsService) {}

  @Get()
  @RequirePermission('Permission.Administration.ViewLogs')
  @ApiOperation({
    summary: 'Журнал действий',
    description:
      'Постраничный список действий, свежие сверху (ТЗ 3.6). Пишутся **изменяющие** ' +
      'запросы: успешные (2xx) и отказы доступа (401/403). Чтения, ошибки формы (400/422) ' +
      'и сбои сервера (500) в журнал не попадают — первые похоронили бы действия под ' +
      'шумом, вторые действиями не являются, а сбои со стектрейсом лежат в логе ' +
      'приложения. Период задаётся календарными датами, обе границы включающие; ' +
      'длиннее года — 400. `search` ищет по имени и телефону действующего лица, ' +
      'коду действия и маршруту.',
  })
  @ApiPaginatedResponse(AuditLogDto, { description: 'Действия' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: AuditLogQueryDto): Promise<Paginated<AuditLogDto>> {
    return this.logs.findAll(query);
  }
}
