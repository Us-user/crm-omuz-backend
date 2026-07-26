import { Injectable } from '@nestjs/common';
import type {
  DirectoryStatus,
  LessonType,
  Prisma,
  ResourceFileType,
  ResourceKind,
} from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { LessonSortField, ResourceFileSortField } from './dto';

const LESSON_SELECT = {
  id: true,
  courseId: true,
  dayNumber: true,
  title: true,
  description: true,
  type: true,
  status: true,
  createdAt: true,
  // Мультивыбор «Show to group» (ТЗ 5.6) отдаётся вместе с уроком: экран должен
  // отрисовать проставленные галочки, а групп у урока единицы.
  visibleToGroups: {
    select: { group: { select: { id: true, name: true } } },
    orderBy: { group: { name: 'asc' } },
  },
  // Счётчик, а не сами материалы: в списке программы нужно только число,
  // сами файлы читаются с карточки урока отдельным маршрутом (ТЗ 5.6).
  _count: { select: { files: true } },
} satisfies Prisma.SyllabusLessonSelect;

export type LessonRow = Prisma.SyllabusLessonGetPayload<{ select: typeof LESSON_SELECT }>;

const RESOURCE_FILE_SELECT = {
  id: true,
  lessonId: true,
  title: true,
  kind: true,
  fileType: true,
  url: true,
  description: true,
  createdAt: true,
} satisfies Prisma.ResourceFileSelect;

export type ResourceFileRow = Prisma.ResourceFileGetPayload<{
  select: typeof RESOURCE_FILE_SELECT;
}>;

export interface LessonListParams {
  courseId: string;
  search?: string;
  type?: LessonType;
  status?: DirectoryStatus;
  /** Только уроки, открытые этой группе («Show to group», ТЗ 5.6). */
  groupId?: string;
  sort: LessonSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface LessonWriteInput {
  courseId: string;
  dayNumber: number;
  title: string;
  description: string | null;
  type?: LessonType;
  status?: DirectoryStatus;
}

/** `undefined` — колонку не менять; значение (включая `null`) — записать. */
export type LessonUpdateInput = Partial<Omit<LessonWriteInput, 'courseId'>>;

export interface ResourceFileListParams {
  lessonId: string;
  search?: string;
  kind?: ResourceKind;
  fileType?: ResourceFileType;
  sort: ResourceFileSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface ResourceFileWriteInput {
  lessonId: string;
  title: string;
  kind?: ResourceKind;
  fileType?: ResourceFileType;
  url: string;
  description: string | null;
}

/**
 * Доступ к данным силлабуса (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class SyllabusRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findLessons(params: LessonListParams): Promise<{ rows: LessonRow[]; total: number }> {
    const where: Prisma.SyllabusLessonWhereInput = {
      courseId: params.courseId,
      ...(params.type === undefined ? {} : { type: params.type }),
      ...(params.status === undefined ? {} : { status: params.status }),
      ...(params.groupId === undefined
        ? {}
        : { visibleToGroups: { some: { groupId: params.groupId } } }),
      ...(params.search === undefined
        ? {}
        : {
            OR: [
              { title: { contains: params.search, mode: 'insensitive' } },
              { description: { contains: params.search, mode: 'insensitive' } },
            ],
          }),
    };

    // Ключ `orderBy` собирается ветвлением, а не из строки: вычисляемое поле
    // прошло бы типизацию Prisma и упало бы уже в БД.
    //
    // Номер дня не уникален (в один день бывают и лекция, и практика), поэтому
    // вторым ключом идёт время создания: без него порядок уроков одного дня
    // зависел бы от плана запроса и менялся между страницами.
    const orderBy: Prisma.SyllabusLessonOrderByWithRelationInput[] =
      params.sort === LessonSortField.Title
        ? [{ title: params.order }]
        : params.sort === LessonSortField.CreatedAt
          ? [{ createdAt: params.order }]
          : [{ dayNumber: params.order }, { createdAt: 'asc' }];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.syllabusLesson.findMany({
        where,
        select: LESSON_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.syllabusLesson.count({ where }),
    ]);

    return { rows, total };
  }

  /**
   * Урок ищется вместе с курсом из пути: иначе через `/courses/A/lessons/{id}`
   * можно было бы прочитать и править урок курса B.
   */
  findLesson(courseId: string, lessonId: string): Promise<LessonRow | null> {
    return this.prisma.syllabusLesson.findFirst({
      where: { id: lessonId, courseId },
      select: LESSON_SELECT,
    });
  }

  findCourse(id: string): Promise<{ id: string; title: string } | null> {
    return this.prisma.course.findUnique({ where: { id }, select: { id: true, title: true } });
  }

  /**
   * Группы курса из переданного списка. Возвращаются только найденные —
   * сервис сравнивает количество и называет недостающие.
   */
  findCourseGroups(courseId: string, groupIds: string[]): Promise<{ id: string; name: string }[]> {
    return this.prisma.group.findMany({
      where: { courseId, id: { in: groupIds } },
      select: { id: true, name: true },
    });
  }

  /**
   * Создание урока вместе с мультивыбором групп — одной транзакцией:
   * урок без обещанной видимости был бы худшим исходом, чем отказ целиком.
   */
  async createLesson(input: LessonWriteInput, visibleToGroupIds: string[]): Promise<LessonRow> {
    return this.prisma.$transaction(async (tx) => {
      const lesson = await tx.syllabusLesson.create({ data: input, select: { id: true } });

      if (visibleToGroupIds.length > 0) {
        await tx.syllabusLessonGroup.createMany({
          data: visibleToGroupIds.map((groupId) => ({ lessonId: lesson.id, groupId })),
        });
      }

      return tx.syllabusLesson.findUniqueOrThrow({
        where: { id: lesson.id },
        select: LESSON_SELECT,
      });
    });
  }

  /**
   * Правка урока. `visibleToGroupIds === undefined` — мультивыбор не трогать;
   * переданный список заменяет набор целиком (иначе снять группу было бы нечем).
   */
  async updateLesson(
    lessonId: string,
    input: LessonUpdateInput,
    visibleToGroupIds?: string[],
  ): Promise<LessonRow> {
    return this.prisma.$transaction(async (tx) => {
      // `undefined` Prisma пропускает: не переданное поле остаётся прежним.
      await tx.syllabusLesson.update({ where: { id: lessonId }, data: input });

      if (visibleToGroupIds !== undefined) {
        await tx.syllabusLessonGroup.deleteMany({ where: { lessonId } });
        if (visibleToGroupIds.length > 0) {
          await tx.syllabusLessonGroup.createMany({
            data: visibleToGroupIds.map((groupId) => ({ lessonId, groupId })),
          });
        }
      }

      return tx.syllabusLesson.findUniqueOrThrow({
        where: { id: lessonId },
        select: LESSON_SELECT,
      });
    });
  }

  /** Материалы и видимость уносит каскад — отдельной чистки не требуется. */
  async deleteLesson(lessonId: string): Promise<void> {
    await this.prisma.syllabusLesson.delete({ where: { id: lessonId } });
  }

  async findFiles(
    params: ResourceFileListParams,
  ): Promise<{ rows: ResourceFileRow[]; total: number }> {
    const where: Prisma.ResourceFileWhereInput = {
      lessonId: params.lessonId,
      ...(params.kind === undefined ? {} : { kind: params.kind }),
      ...(params.fileType === undefined ? {} : { fileType: params.fileType }),
      ...(params.search === undefined
        ? {}
        : {
            OR: [
              { title: { contains: params.search, mode: 'insensitive' } },
              { description: { contains: params.search, mode: 'insensitive' } },
            ],
          }),
    };

    const orderBy: Prisma.ResourceFileOrderByWithRelationInput =
      params.sort === ResourceFileSortField.Title
        ? { title: params.order }
        : { createdAt: params.order };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.resourceFile.findMany({
        where,
        select: RESOURCE_FILE_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.resourceFile.count({ where }),
    ]);

    return { rows, total };
  }

  /** Файл ищется вместе с уроком — по той же причине, что урок вместе с курсом. */
  findFile(lessonId: string, fileId: string): Promise<ResourceFileRow | null> {
    return this.prisma.resourceFile.findFirst({
      where: { id: fileId, lessonId },
      select: RESOURCE_FILE_SELECT,
    });
  }

  createFile(input: ResourceFileWriteInput): Promise<ResourceFileRow> {
    return this.prisma.resourceFile.create({ data: input, select: RESOURCE_FILE_SELECT });
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.prisma.resourceFile.delete({ where: { id: fileId } });
  }
}
