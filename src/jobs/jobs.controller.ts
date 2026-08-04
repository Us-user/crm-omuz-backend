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
// Прямой путь, а не barrel `../rbac`: тот реэкспортирует ещё и сервисы
// с репозиториями, а контроллеру нужен только декоратор.
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { CreateJobDto, JobDeletedDto, JobDto, JobQueryDto, UpdateJobDto } from './dto';
import { JobsService } from './jobs.service';

/**
 * Вакансии, админ-сторона (ТЗ 5.18: «ручной список актуальных вакансий,
 * CRUD админом»).
 *
 * Сотрудник видит **все** вакансии — включая выключенные и просроченные:
 * это рабочий список, который ведут, а не витрина. Студенту адресован
 * `GET /me/jobs`, где видны только актуальные (`MeJobsController`).
 */
@ApiTags('Jobs')
@ApiBearerAuth('access-token')
@Controller('jobs')
// Список ведут сотрудники; студенту положен только просмотр актуальных
// в своём кабинете (ТЗ 3.2). Конкретное действие проверяет право каталога.
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  @RequirePermission('Permission.Jobs.Views')
  @ApiOperation({
    summary: 'Список вакансий',
    description:
      'Постраничный список (ТЗ 5.18). `search` — по названию, компании, описанию ' +
      'и требованиям. Фильтр `open` сверяет статус и срок с сегодняшним днём ' +
      'и отличается от `status`: вакансия бывает включённой, но с истёкшим сроком. ' +
      'Порядок по умолчанию — свежие сверху.',
  })
  @ApiPaginatedResponse(JobDto, { description: 'Вакансии' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: JobQueryDto): Promise<Paginated<JobDto>> {
    return this.jobs.findAll(query);
  }

  @Get(':id')
  @RequirePermission('Permission.Jobs.Views')
  @ApiOperation({ summary: 'Карточка вакансии' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(JobDto, { description: 'Вакансия' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<JobDto> {
    return this.jobs.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Jobs.Create')
  @ApiOperation({
    summary: 'Создание вакансии',
    description:
      'Обязательны название, компания и контакты; описание, требования и срок — ' +
      'по мере того, как работодатель их сообщает. **Проверки уникальности нет**: ' +
      'одна и та же должность законно повторяется у разных компаний и в разные ' +
      'сезоны. Срок `YYYY-MM-DD` включающий, пустая строка означает «бессрочно».',
  })
  @ApiDataResponse(JobDto, { status: HttpStatus.CREATED, description: 'Вакансия заведена' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  create(@Body() dto: CreateJobDto): Promise<JobDto> {
    return this.jobs.create(dto);
  }

  @Put(':id')
  @RequirePermission('Permission.Jobs.Update')
  @ApiOperation({
    summary: 'Правка вакансии',
    description:
      'Не переданное поле остаётся прежним, пустая строка очищает описание, ' +
      'требования или снимает срок. Название, компанию и контакты очистить нельзя — ' +
      'пустая строка в них отбивается как 400.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(JobDto, { description: 'Обновлённая вакансия' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateJobDto): Promise<JobDto> {
    return this.jobs.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('Permission.Jobs.Delete')
  @ApiOperation({
    summary: 'Удаление вакансии',
    description:
      'Без ограничений — на вакансию не ссылается ни одна запись, и откликов ' +
      'система не принимает. Чтобы убрать вакансию из кабинета студента, но ' +
      'сохранить её в списке центра, переведите её в `INACTIVE`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(JobDeletedDto, { description: 'Вакансия удалена' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<JobDeletedDto> {
    return this.jobs.remove(id);
  }
}
