import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { emptyToNull, emptyToNullPatch, Paginated } from '../common';
import type { CourseRow } from './courses.repository';
import { CoursesRepository } from './courses.repository';
import type {
  CourseDeletedDto,
  CourseDto,
  CourseQueryDto,
  CreateCourseDto,
  UpdateCourseDto,
} from './dto';

/**
 * Каталог курсов (ТЗ 5.6).
 *
 * Два поля здесь важнее остальных и потому названы явно:
 *   - `fee` — стоимость курса; курсы длятся около месяца, поэтому она же
 *     станет помесячным начислением в бухгалтерии (ТЗ 5.16);
 *   - `isLastCourse` — «Is last course»: завершение группы такого курса
 *     запускает автовыпуск студентов (ТЗ 5.11).
 */
@Injectable()
export class CoursesService {
  private readonly logger = new Logger(CoursesService.name);

  constructor(private readonly repository: CoursesRepository) {}

  async findAll(query: CourseQueryDto): Promise<Paginated<CourseDto>> {
    const { rows, total } = await this.repository.findMany({
      search: query.search,
      status: query.status,
      isLastCourse: query.isLastCourse,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toDto), total, query);
  }

  async findOne(id: string): Promise<CourseDto> {
    return toDto(await this.require(id));
  }

  async create(dto: CreateCourseDto): Promise<CourseDto> {
    await this.assertTitleFree(dto.title);

    const course = await this.repository.create({
      title: dto.title,
      subtitle: emptyToNull(dto.subtitle),
      description: emptyToNull(dto.description),
      fee: dto.fee,
      isLastCourse: dto.isLastCourse,
      colorPrimary: emptyToNull(dto.colorPrimary),
      colorSecondary: emptyToNull(dto.colorSecondary),
      logoUrl: emptyToNull(dto.logoUrl),
      durationValue: dto.durationValue,
      durationUnit: dto.durationUnit,
      status: dto.status,
    });

    this.logger.log(`Создан курс ${course.title} (${course.id})`);

    return toDto(course);
  }

  async update(id: string, dto: UpdateCourseDto): Promise<CourseDto> {
    await this.require(id);

    if (dto.title !== undefined) {
      await this.assertTitleFree(dto.title, id);
    }

    const course = await this.repository.update(id, {
      title: dto.title,
      subtitle: emptyToNullPatch(dto.subtitle),
      description: emptyToNullPatch(dto.description),
      fee: dto.fee,
      isLastCourse: dto.isLastCourse,
      colorPrimary: emptyToNullPatch(dto.colorPrimary),
      colorSecondary: emptyToNullPatch(dto.colorSecondary),
      logoUrl: emptyToNullPatch(dto.logoUrl),
      durationValue: dto.durationValue,
      durationUnit: dto.durationUnit,
      status: dto.status,
    });

    this.logger.log(`Изменён курс ${course.title} (${course.id})`);

    return toDto(course);
  }

  /**
   * Удаление курса. Курс, по которому набраны группы, не удаляется: внешний
   * ключ стоит `RESTRICT` и БД такое удаление и так не пропустит, но проверка
   * здесь нужна, чтобы наружу ушла причина, а не обезличенная ошибка связи.
   */
  async remove(id: string): Promise<CourseDeletedDto> {
    const course = await this.require(id);

    if (course._count.groups > 0) {
      throw new ConflictException(
        `По курсу учатся группы (${String(course._count.groups)}) — удалите или переведите их перед удалением курса`,
      );
    }

    await this.repository.delete(id);
    this.logger.log(`Удалён курс ${course.title} (${id})`);

    return { id: course.id, title: course.title };
  }

  private async require(id: string): Promise<CourseRow> {
    const course = await this.repository.findById(id);
    if (!course) {
      throw new NotFoundException('Курс не найден');
    }

    return course;
  }

  private async assertTitleFree(title: string, exceptId?: string): Promise<void> {
    const twin = await this.repository.findByTitle(title);
    if (twin && twin.id !== exceptId) {
      throw new ConflictException(`Курс с названием «${twin.title}» уже существует`);
    }
  }
}

const toDto = (row: CourseRow): CourseDto => ({
  id: row.id,
  title: row.title,
  subtitle: row.subtitle,
  description: row.description,
  // `Prisma.Decimal` → число через `Number()`, а не `toNumber()`: так же
  // корректно, но не падает, если в слое данных лежит обычное число.
  // DECIMAL(12,2) представим в double точно, поэтому округления здесь нет.
  fee: Number(row.fee),
  isLastCourse: row.isLastCourse,
  colorPrimary: row.colorPrimary,
  colorSecondary: row.colorSecondary,
  logoUrl: row.logoUrl,
  durationValue: row.durationValue,
  durationUnit: row.durationUnit,
  status: row.status,
  groupsCount: row._count.groups,
  createdAt: row.createdAt.toISOString(),
});
