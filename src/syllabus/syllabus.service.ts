import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { BusinessRuleException, emptyToNull, emptyToNullPatch, Paginated } from '../common';
import type {
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
import type { LessonRow, ResourceFileRow } from './syllabus.repository';
import { SyllabusRepository } from './syllabus.repository';

/**
 * Силлабус курса и материалы уроков (ТЗ 5.6).
 *
 * Правила модуля:
 *   - курс из пути должен существовать (404) — он часть адреса, а не тела;
 *   - урок ищется **внутри своего курса**: через `/courses/A/lessons/{id}`
 *     урок курса B не найдётся (404). То же для файла внутри урока;
 *   - «Show to group» принимает только группы **этого же курса** (422):
 *     показать урок группе другой программы бессмысленно;
 *   - `visibleToGroupIds` в `PUT` заменяет мультивыбор целиком, пустой массив
 *     снимает всех; не переданное поле мультивыбор не трогает.
 *
 * Номер дня не проверяется на уникальность: в один учебный день может стоять
 * и лекция, и практика (см. комментарий у модели `SyllabusLesson`).
 */
@Injectable()
export class SyllabusService {
  private readonly logger = new Logger(SyllabusService.name);

  constructor(private readonly repository: SyllabusRepository) {}

  // ───────────────────────────── Уроки программы ─────────────────────────────

  async findAllLessons(courseId: string, query: LessonQueryDto): Promise<Paginated<LessonDto>> {
    await this.requireCourse(courseId);

    const { rows, total } = await this.repository.findLessons({
      courseId,
      search: query.search,
      type: query.type,
      status: query.status,
      groupId: query.groupId,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toLessonDto), total, query);
  }

  async findOneLesson(courseId: string, lessonId: string): Promise<LessonDto> {
    return toLessonDto(await this.requireLesson(courseId, lessonId));
  }

  async createLesson(courseId: string, dto: CreateLessonDto): Promise<LessonDto> {
    await this.requireCourse(courseId);

    const visibleToGroupIds = await this.resolveVisibleGroups(courseId, dto.visibleToGroupIds);

    const lesson = await this.repository.createLesson(
      {
        courseId,
        dayNumber: dto.dayNumber,
        title: dto.title,
        description: emptyToNull(dto.description),
        type: dto.type,
        status: dto.status,
      },
      visibleToGroupIds ?? [],
    );

    this.logger.log(
      `Добавлен урок «${lesson.title}» (день ${String(lesson.dayNumber)}) в программу курса ${courseId}`,
    );

    return toLessonDto(lesson);
  }

  async updateLesson(courseId: string, lessonId: string, dto: UpdateLessonDto): Promise<LessonDto> {
    await this.requireLesson(courseId, lessonId);

    const visibleToGroupIds = await this.resolveVisibleGroups(courseId, dto.visibleToGroupIds);

    const lesson = await this.repository.updateLesson(
      lessonId,
      {
        dayNumber: dto.dayNumber,
        title: dto.title,
        description: emptyToNullPatch(dto.description),
        type: dto.type,
        status: dto.status,
      },
      visibleToGroupIds,
    );

    this.logger.log(`Изменён урок «${lesson.title}» (${lesson.id})`);

    return toLessonDto(lesson);
  }

  /**
   * Удаление урока. Материалы и мультивыбор групп уносит каскад: файл вне урока
   * адресовать нечем, а видимость — настройка экрана, а не данные, которые
   * стоило бы защищать отказом (в отличие от групп у филиала).
   */
  async removeLesson(courseId: string, lessonId: string): Promise<LessonDeletedDto> {
    const lesson = await this.requireLesson(courseId, lessonId);

    await this.repository.deleteLesson(lessonId);
    this.logger.log(
      `Удалён урок «${lesson.title}» и его материалы (${String(lesson._count.files)}) из курса ${courseId}`,
    );

    return { id: lesson.id, dayNumber: lesson.dayNumber, title: lesson.title };
  }

  // ──────────────────────────── Материалы урока ─────────────────────────────

  async findAllFiles(
    courseId: string,
    lessonId: string,
    query: ResourceFileQueryDto,
  ): Promise<Paginated<ResourceFileDto>> {
    await this.requireLesson(courseId, lessonId);

    const { rows, total } = await this.repository.findFiles({
      lessonId,
      search: query.search,
      kind: query.kind,
      fileType: query.fileType,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toFileDto), total, query);
  }

  async createFile(
    courseId: string,
    lessonId: string,
    dto: CreateResourceFileDto,
  ): Promise<ResourceFileDto> {
    await this.requireLesson(courseId, lessonId);

    const file = await this.repository.createFile({
      lessonId,
      title: dto.title,
      kind: dto.kind,
      fileType: dto.fileType,
      url: dto.url,
      description: emptyToNull(dto.description),
    });

    this.logger.log(`К уроку ${lessonId} добавлен материал «${file.title}»`);

    return toFileDto(file);
  }

  async removeFile(
    courseId: string,
    lessonId: string,
    fileId: string,
  ): Promise<ResourceFileDeletedDto> {
    await this.requireLesson(courseId, lessonId);

    const file = await this.repository.findFile(lessonId, fileId);
    if (!file) {
      throw new NotFoundException('Материал не найден');
    }

    await this.repository.deleteFile(fileId);
    this.logger.log(`Удалён материал «${file.title}» урока ${lessonId}`);

    return { id: file.id, title: file.title };
  }

  // ──────────────────────────────── Правила ─────────────────────────────────

  private async requireCourse(courseId: string): Promise<void> {
    const course = await this.repository.findCourse(courseId);
    if (!course) {
      throw new NotFoundException('Курс не найден');
    }
  }

  /**
   * Урок вместе с курсом из пути. Курс проверяется отдельно, чтобы отличить
   * «нет такого курса» от «у курса нет такого урока»: без этого опечатка
   * в идентификаторе курса выглядела бы как пропавший урок.
   */
  private async requireLesson(courseId: string, lessonId: string): Promise<LessonRow> {
    await this.requireCourse(courseId);

    const lesson = await this.repository.findLesson(courseId, lessonId);
    if (!lesson) {
      throw new NotFoundException('Урок не найден в программе этого курса');
    }

    return lesson;
  }

  /**
   * Проверяет мультивыбор «Show to group» (ТЗ 5.6).
   *
   * 422, а не 404: ресурс из пути найден, не найдено то, что пришло в теле —
   * то же правило, что при назначении ролей (сессия 0006) и при ссылке
   * на филиал в группе (сессии 0007–0008). Молча отбросить неизвестный
   * идентификатор нельзя: оператор решил бы, что урок группе открыт.
   *
   * @returns `undefined`, если поле не передано (мультивыбор не трогать).
   */
  private async resolveVisibleGroups(
    courseId: string,
    groupIds: string[] | undefined,
  ): Promise<string[] | undefined> {
    if (groupIds === undefined) return undefined;
    if (groupIds.length === 0) return [];

    const found = await this.repository.findCourseGroups(courseId, groupIds);
    if (found.length !== groupIds.length) {
      const known = new Set(found.map((group) => group.id));
      const missing = groupIds.filter((id) => !known.has(id));

      throw new BusinessRuleException('Урок можно открыть только группам этого же курса', {
        visibleToGroupIds: missing,
      });
    }

    return groupIds;
  }
}

const toLessonDto = (row: LessonRow): LessonDto => ({
  id: row.id,
  courseId: row.courseId,
  dayNumber: row.dayNumber,
  title: row.title,
  description: row.description,
  type: row.type,
  status: row.status,
  visibleToGroups: row.visibleToGroups.map((link) => link.group),
  filesCount: row._count.files,
  createdAt: row.createdAt.toISOString(),
});

const toFileDto = (row: ResourceFileRow): ResourceFileDto => ({
  id: row.id,
  lessonId: row.lessonId,
  title: row.title,
  kind: row.kind,
  fileType: row.fileType,
  url: row.url,
  description: row.description,
  createdAt: row.createdAt.toISOString(),
});
