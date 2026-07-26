import { Injectable } from '@nestjs/common';
import type { DirectoryStatus, DurationUnit, Prisma } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { CourseSortField } from './dto';

const COURSE_SELECT = {
  id: true,
  title: true,
  subtitle: true,
  description: true,
  fee: true,
  isLastCourse: true,
  colorPrimary: true,
  colorSecondary: true,
  logoUrl: true,
  durationValue: true,
  durationUnit: true,
  status: true,
  createdAt: true,
  // «Кол-во групп» с карточки курса (ТЗ 5.6). Счётчик, а не сами группы:
  // на экране каталога нужно только число, а групп у курса за годы много.
  // На нём же держится запрет удалять курс, по которому кто-то учится.
  _count: { select: { groups: true } },
} satisfies Prisma.CourseSelect;

export type CourseRow = Prisma.CourseGetPayload<{ select: typeof COURSE_SELECT }>;

export interface CourseListParams {
  search?: string;
  status?: DirectoryStatus;
  isLastCourse?: boolean;
  sort: CourseSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface CourseWriteInput {
  title: string;
  subtitle: string | null;
  description: string | null;
  fee: number;
  isLastCourse?: boolean;
  colorPrimary: string | null;
  colorSecondary: string | null;
  logoUrl: string | null;
  durationValue: number;
  durationUnit?: DurationUnit;
  status?: DirectoryStatus;
}

/** `undefined` — колонку не менять; значение (включая `null`) — записать. */
export type CourseUpdateInput = Partial<CourseWriteInput>;

/**
 * Доступ к данным курсов (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class CoursesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: CourseListParams): Promise<{ rows: CourseRow[]; total: number }> {
    const where: Prisma.CourseWhereInput = {
      ...(params.status === undefined ? {} : { status: params.status }),
      ...(params.isLastCourse === undefined ? {} : { isLastCourse: params.isLastCourse }),
      ...(params.search === undefined
        ? {}
        : {
            OR: [
              { title: { contains: params.search, mode: 'insensitive' } },
              { subtitle: { contains: params.search, mode: 'insensitive' } },
              { description: { contains: params.search, mode: 'insensitive' } },
            ],
          }),
    };

    const orderBy: Prisma.CourseOrderByWithRelationInput =
      params.sort === CourseSortField.Title
        ? { title: params.order }
        : params.sort === CourseSortField.Fee
          ? { fee: params.order }
          : { createdAt: params.order };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.course.findMany({
        where,
        select: COURSE_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.course.count({ where }),
    ]);

    return { rows, total };
  }

  findById(id: string): Promise<CourseRow | null> {
    return this.prisma.course.findUnique({ where: { id }, select: COURSE_SELECT });
  }

  /** Тёзка без учёта регистра: «Frontend Basic» и «frontend basic» — один курс. */
  findByTitle(title: string): Promise<{ id: string; title: string } | null> {
    return this.prisma.course.findFirst({
      where: { title: { equals: title, mode: 'insensitive' } },
      select: { id: true, title: true },
    });
  }

  create(input: CourseWriteInput): Promise<CourseRow> {
    return this.prisma.course.create({ data: input, select: COURSE_SELECT });
  }

  update(id: string, input: CourseUpdateInput): Promise<CourseRow> {
    return this.prisma.course.update({ where: { id }, data: input, select: COURSE_SELECT });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.course.delete({ where: { id } });
  }
}
