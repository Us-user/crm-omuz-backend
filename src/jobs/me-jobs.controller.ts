import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import { AccountTypeGuard, RequireAccountType } from '../auth';
import type { Paginated } from '../common';
import { ApiPaginatedResponse, ApiStandardErrors } from '../common';
import { MeJobDto, MeJobQueryDto } from './dto';
import { JobsService } from './jobs.service';

/**
 * Вакансии в кабинете студента (ТЗ 5.18; аудитория — решение пользователя,
 * сессия 0039).
 *
 * ТЗ 5.18 называет список «актуальных вакансий», но перечисляет только маршруты
 * администратора. Читателя у такого списка не было бы вовсе: центр ведёт
 * вакансии ради студентов и выпускников (ТЗ 5.11 прямо отслеживает
 * их трудоустройство), а не ради собственного архива.
 *
 * **Третий контур «своё»** после кабинета студента (0017) и кабинета ментора
 * (0023), и устроен он по тем же правилам: прав каталога здесь нет и быть
 * не может (права даются позициями, а позиции есть только у сотрудников,
 * ТЗ 3.2), доступ ограничивает тип аккаунта, а заблокированному студенту
 * `JwtAuthGuard` отказывает сразу (0017).
 *
 * Живёт **в модуле вакансий вторым контроллером**, а не в `StudentCabinetModule`:
 * тот же приём, что с рассмотрением аванса в `src/avans` (0031) и рассылкой
 * своей группе в `src/mailings` (0037). Правило «студент видит только
 * актуальные» должно стоять рядом с тем, что понимает, какая вакансия
 * актуальна, — иначе кабинету пришлось бы завести второй репозиторий вакансий
 * и второе определение «актуальности».
 *
 * Карточки (`GET /me/jobs/{id}`) здесь нет намеренно: у вакансии нет ни связей,
 * ни счётчиков, и список отдаёт её целиком — карточка вернула бы ровно ту же
 * запись вторым способом.
 */
@ApiTags('Student cabinet')
@ApiBearerAuth('access-token')
@Controller('me/jobs')
@RequireAccountType(AccountType.STUDENT)
@UseGuards(AccountTypeGuard)
export class MeJobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  @ApiOperation({
    summary: 'Актуальные вакансии',
    description:
      'Постраничный список вакансий, открытых **сегодня** (ТЗ 5.18): статус `ACTIVE` ' +
      'и срок не прошёл, включая бессрочные. Снятые и просроченные сюда не попадают ' +
      'ни при каких параметрах запроса — отбор задан маршрутом, а не фильтром. ' +
      '`search` — по названию, компании, описанию и требованиям.',
  })
  @ApiPaginatedResponse(MeJobDto, { description: 'Актуальные вакансии' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findOpen(@Query() query: MeJobQueryDto): Promise<Paginated<MeJobDto>> {
    return this.jobs.findOpen(query);
  }
}
