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
  CreateLessonDto,
  CreateResourceFileDto,
  LessonDeletedDto,
  LessonDto,
  LessonQueryDto,
  ResourceFileDeletedDto,
  ResourceFileDto,
  ResourceFileQueryDto,
  UpdateLessonDto,
} from './dto';
import { SyllabusService } from './syllabus.service';

/**
 * Силлабус курса (ТЗ 5.6) — уроки программы и их материалы.
 *
 * Маршруты вложены в курс (`/courses/{courseId}/lessons…`), как задано ТЗ:
 * программа не существует отдельно от курса, и адрес урока сам подтверждает,
 * какому курсу он принадлежит.
 */
@ApiTags('Syllabus')
@ApiBearerAuth('access-token')
@Controller('courses/:courseId/lessons')
@RequireAccountType(AccountType.EMPLOYEE)
@UseGuards(AccountTypeGuard)
export class SyllabusController {
  constructor(private readonly syllabus: SyllabusService) {}

  @Get()
  @RequirePermission('Permission.Syllabus.Views')
  @ApiOperation({
    summary: 'Программа курса',
    description:
      'Постраничный список уроков, по умолчанию в порядке учебных дней. Фильтры `type`, ' +
      '`status` и `groupId` («Show to group» — что открыто конкретной группе), ' +
      'поиск `search` — по названию и описанию урока.',
  })
  @ApiParam({ name: 'courseId', format: 'uuid' })
  @ApiPaginatedResponse(LessonDto, { description: 'Уроки программы' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findAll(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Query() query: LessonQueryDto,
  ): Promise<Paginated<LessonDto>> {
    return this.syllabus.findAllLessons(courseId, query);
  }

  @Get(':lessonId')
  @RequirePermission('Permission.Syllabus.Views')
  @ApiOperation({
    summary: 'Карточка урока',
    description: 'Урок ищется внутри своего курса: урок чужого курса по этому адресу не найдётся.',
  })
  @ApiParam({ name: 'courseId', format: 'uuid' })
  @ApiParam({ name: 'lessonId', format: 'uuid' })
  @ApiDataResponse(LessonDto, { description: 'Урок' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
  ): Promise<LessonDto> {
    return this.syllabus.findOneLesson(courseId, lessonId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Syllabus.Create')
  @ApiOperation({
    summary: 'Добавление урока в программу',
    description:
      'Номер дня («Day N») не уникален: в один день может стоять и лекция, и практика. ' +
      '`visibleToGroupIds` («Show to group») принимает только группы этого же курса (422).',
  })
  @ApiParam({ name: 'courseId', format: 'uuid' })
  @ApiDataResponse(LessonDto, { description: 'Урок добавлен', status: HttpStatus.CREATED })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  create(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Body() dto: CreateLessonDto,
  ): Promise<LessonDto> {
    return this.syllabus.createLesson(courseId, dto);
  }

  @Put(':lessonId')
  @RequirePermission('Permission.Syllabus.Update')
  @ApiOperation({
    summary: 'Правка урока',
    description:
      'Не переданное поле остаётся прежним; пустая строка в необязательном поле очищает его. ' +
      '`visibleToGroupIds` заменяет мультивыбор целиком, пустой массив снимает всех.',
  })
  @ApiParam({ name: 'courseId', format: 'uuid' })
  @ApiParam({ name: 'lessonId', format: 'uuid' })
  @ApiDataResponse(LessonDto, { description: 'Урок изменён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  update(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Body() dto: UpdateLessonDto,
  ): Promise<LessonDto> {
    return this.syllabus.updateLesson(courseId, lessonId, dto);
  }

  @Delete(':lessonId')
  @RequirePermission('Permission.Syllabus.Delete')
  @ApiOperation({
    summary: 'Удаление урока',
    description:
      'Вместе с уроком удаляются его материалы и мультивыбор групп. Чтобы скрыть урок, ' +
      'не теряя материалы, переведите его в статус INACTIVE.',
  })
  @ApiParam({ name: 'courseId', format: 'uuid' })
  @ApiParam({ name: 'lessonId', format: 'uuid' })
  @ApiDataResponse(LessonDeletedDto, { description: 'Урок удалён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  remove(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
  ): Promise<LessonDeletedDto> {
    return this.syllabus.removeLesson(courseId, lessonId);
  }

  // ──────────────────────────── Материалы урока ─────────────────────────────

  @Get(':lessonId/files')
  @RequirePermission('Permission.Syllabus.Views')
  @ApiOperation({
    summary: 'Материалы урока',
    description:
      'Постраничный список ссылок на материалы (ТЗ 5.6). Фильтры `kind` (зачем материал) ' +
      'и `fileType` (что это за файл).',
  })
  @ApiParam({ name: 'courseId', format: 'uuid' })
  @ApiParam({ name: 'lessonId', format: 'uuid' })
  @ApiPaginatedResponse(ResourceFileDto, { description: 'Материалы' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findAllFiles(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Query() query: ResourceFileQueryDto,
  ): Promise<Paginated<ResourceFileDto>> {
    return this.syllabus.findAllFiles(courseId, lessonId, query);
  }

  @Post(':lessonId/files')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('Permission.Syllabus.Create')
  @ApiOperation({
    summary: 'Добавление материала к уроку',
    description:
      'Принимается ссылка на внешнее хранилище, а не сам файл: приём загрузок — ' +
      'отдельный кусок инфраструктуры.',
  })
  @ApiParam({ name: 'courseId', format: 'uuid' })
  @ApiParam({ name: 'lessonId', format: 'uuid' })
  @ApiDataResponse(ResourceFileDto, {
    description: 'Материал добавлен',
    status: HttpStatus.CREATED,
  })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  createFile(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Body() dto: CreateResourceFileDto,
  ): Promise<ResourceFileDto> {
    return this.syllabus.createFile(courseId, lessonId, dto);
  }

  /**
   * Удаления материала в перечне маршрутов ТЗ 5.6 нет, но каталог прав
   * называет его прямо («Удаление урока или файла»), а материал, добавленный
   * по ошибке, иначе нельзя было бы убрать, не удалив весь урок.
   */
  @Delete(':lessonId/files/:fileId')
  @RequirePermission('Permission.Syllabus.Delete')
  @ApiOperation({ summary: 'Удаление материала урока' })
  @ApiParam({ name: 'courseId', format: 'uuid' })
  @ApiParam({ name: 'lessonId', format: 'uuid' })
  @ApiParam({ name: 'fileId', format: 'uuid' })
  @ApiDataResponse(ResourceFileDeletedDto, { description: 'Материал удалён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  removeFile(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ): Promise<ResourceFileDeletedDto> {
    return this.syllabus.removeFile(courseId, lessonId, fileId);
  }
}
