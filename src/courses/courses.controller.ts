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
import { CoursesService } from './courses.service';
import {
  CourseDeletedDto,
  CourseDto,
  CourseQueryDto,
  CreateCourseDto,
  UpdateCourseDto,
} from './dto';

/**
 * Каталог курсов (ТЗ 5.6). Силлабус (`/courses/{id}/lessons`) и счётчик групп
 * добавляются следующими кусками Фазы 3.
 */
@ApiTags('Courses')
@ApiBearerAuth('access-token')
@Controller('courses')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Get()
  @RequirePermission('Permission.Courses.Views')
  @ApiOperation({
    summary: 'Каталог курсов',
    description:
      'Постраничный список. Фильтры `status` и `isLastCourse`, поиск `search` — ' +
      'по названию, подзаголовку и описанию.',
  })
  @ApiPaginatedResponse(CourseDto, { description: 'Курсы' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  findAll(@Query() query: CourseQueryDto): Promise<Paginated<CourseDto>> {
    return this.courses.findAll(query);
  }

  @Get(':id')
  @RequirePermission('Permission.Courses.Views')
  @ApiOperation({ summary: 'Карточка курса' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(CourseDto, { description: 'Курс' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<CourseDto> {
    return this.courses.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Courses.Create')
  @ApiOperation({
    summary: 'Создание курса',
    description:
      'Название уникально без учёта регистра (409). `fee` — в сомони, не более двух ' +
      'знаков после запятой; цвета — в формате `#RRGGBB`.',
  })
  @ApiDataResponse(CourseDto, { description: 'Курс создан', status: HttpStatus.CREATED })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
  )
  create(@Body() dto: CreateCourseDto): Promise<CourseDto> {
    return this.courses.create(dto);
  }

  @Put(':id')
  @RequirePermission('Permission.Courses.Update')
  @ApiOperation({
    summary: 'Правка курса',
    description:
      'Не переданное поле остаётся прежним; пустая строка в необязательном поле очищает его.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(CourseDto, { description: 'Курс изменён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCourseDto): Promise<CourseDto> {
    return this.courses.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('Permission.Courses.Delete')
  @ApiOperation({
    summary: 'Удаление курса',
    description:
      'Чтобы убрать курс из продажи, не теряя историю групп, переведите его в статус INACTIVE.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiDataResponse(CourseDeletedDto, { description: 'Курс удалён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<CourseDeletedDto> {
    return this.courses.remove(id);
  }
}
