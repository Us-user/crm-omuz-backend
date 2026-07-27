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
  CreateMentorLevelDto,
  MentorLevelDeletedDto,
  MentorLevelDto,
  MentorLevelQueryDto,
  UpdateMentorLevelDto,
} from './dto';
import { MentorLevelsService } from './mentor-levels.service';

/**
 * Справочник уровней ментора (ТЗ 5.14: «Mentor levels — CRUD-справочник:
 * уровень + часовая ставка»).
 *
 * Класс закрыт по типу аккаунта целиком: ставки центра — не то, что положено
 * видеть студенту (ТЗ 3.2). Конкретное действие сверх этого закрыто своим
 * правом каталога: `Permission.MentorLevels.*` заведены с сессии 0005
 * и до сих пор никем не требовались.
 */
@ApiTags('Employees')
@ApiBearerAuth('access-token')
@Controller('mentor-levels')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class MentorLevelsController {
  constructor(private readonly levels: MentorLevelsService) {}

  @Get()
  @RequirePermission('Permission.MentorLevels.Views')
  @ApiOperation({
    summary: 'Справочник уровней ментора',
    description:
      'Постраничная лестница ступеней со ставкой и числом месяцев, в которых ступень ' +
      'кому-то проставлена. Фильтр `status`, поиск `search` — по названию и описанию. ' +
      'По умолчанию — по возрастанию ставки: лестницу читают снизу вверх.',
  })
  @ApiPaginatedResponse(MentorLevelDto, { description: 'Уровни ментора' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: MentorLevelQueryDto): Promise<Paginated<MentorLevelDto>> {
    return this.levels.findAll(query);
  }

  @Get(':id')
  @RequirePermission('Permission.MentorLevels.Views')
  @ApiOperation({ summary: 'Карточка уровня ментора' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(MentorLevelDto, { description: 'Уровень ментора' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<MentorLevelDto> {
    return this.levels.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.MentorLevels.Create')
  @ApiOperation({
    summary: 'Создание уровня ментора',
    description: 'Название уникально без учёта регистра (409). Ставка — в сомони, до двух знаков.',
  })
  @ApiDataResponse(MentorLevelDto, { description: 'Уровень создан', status: HttpStatus.CREATED })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
  )
  create(@Body() dto: CreateMentorLevelDto): Promise<MentorLevelDto> {
    return this.levels.create(dto);
  }

  @Put(':id')
  @RequirePermission('Permission.MentorLevels.Update')
  @ApiOperation({
    summary: 'Правка уровня ментора',
    description:
      'Не переданное поле остаётся прежним, пустая строка в описании очищает его. ' +
      '**Новая ставка действует на все месяцы, где стоит эта ступень:** история хранит ' +
      'ссылку на уровень, а не копию его ставки, — справочником уровней центр управляет ' +
      'централизованно (ТЗ 5.14).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(MentorLevelDto, { description: 'Уровень изменён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMentorLevelDto,
  ): Promise<MentorLevelDto> {
    return this.levels.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('Permission.MentorLevels.Delete')
  @ApiOperation({
    summary: 'Удаление уровня ментора',
    description:
      'Только неиспользованной ступени: уровень, проставленный кому-то хотя бы в одном ' +
      'месяце, не удаляется (409) — по нему считается зарплата (ТЗ 5.16). Для «ступень ' +
      'больше не используем» есть статус «INACTIVE».',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(MentorLevelDeletedDto, { description: 'Уровень удалён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<MentorLevelDeletedDto> {
    return this.levels.remove(id);
  }
}
