import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { GroupStudentStatus } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { LeftCourseSortField } from './dto';

/**
 * Строка витрины: кто ушёл, откуда и при ком.
 *
 * Профиль, группа, курс, филиал и ментор отдаются вместе со строкой —
 * отчёт по оттоку читают целиком, и догрузка каждого поля по строке
 * превратила бы одну таблицу в сотню запросов.
 */
const LEFT_COURSE_SELECT = {
  groupId: true,
  studentId: true,
  statusReason: true,
  statusChangedAt: true,
  enrolledAt: true,
  student: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      photoUrl: true,
      // Статус профиля (ТЗ 5.12 описывает витрину как «студенты со статусом
      // No Active»). Он выводится из **всех** членств человека (сессия 0014),
      // поэтому у ушедшего с одного курса и продолжающего на другом здесь
      // будет `ACTIVE` — и это видно, а не спрятано.
      status: true,
    },
  },
  group: {
    select: {
      id: true,
      name: true,
      course: { select: { id: true, title: true } },
      branch: { select: { id: true, name: true } },
    },
  },
  /// Ментор на момент ухода (ТЗ 5.12) — снимок, а не текущий состав менторов.
  mentorAtLeave: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.GroupStudentSelect;

export type LeftCourseRow = Prisma.GroupStudentGetPayload<{ select: typeof LEFT_COURSE_SELECT }>;

/** Минимум для статистики: разрезы и месяц, ничего лишнего. */
const LEFT_COURSE_FACT_SELECT = {
  statusChangedAt: true,
  group: {
    select: {
      id: true,
      name: true,
      course: { select: { id: true, title: true } },
      branch: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.GroupStudentSelect;

export type LeftCourseFactRow = Prisma.GroupStudentGetPayload<{
  select: typeof LEFT_COURSE_FACT_SELECT;
}>;

/**
 * Отбор уходов — общий для списка и для статистики.
 *
 * `from`/`to` — уже разобранные границы: `from` включающая, `to` **не**
 * включающая (первое число месяца, следующего за концом периода). Так отрезок
 * не зависит от того, сколько дней в последнем месяце.
 */
export interface LeftCourseFilter {
  groupId?: string;
  courseId?: string;
  branchId?: string;
  from?: Date;
  to?: Date;
  search?: string;
}

export interface LeftCourseListParams extends LeftCourseFilter {
  sort: LeftCourseSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

/**
 * Отбор строк — один на постраничный список и на статистику: два экрана одного
 * отчёта обязаны отбирать одно и то же **по определению**, а не по совпадению
 * (приём сессии 0013 с выгрузкой состава).
 *
 * `TRANSFERRED` сюда не попадает: переведённый курс не покидал (решение
 * сессии 0012), и один статус на двоих завысил бы отток ровно на число
 * внутренних переводов.
 */
const whereOf = (filter: LeftCourseFilter): Prisma.GroupStudentWhereInput => {
  const group: Prisma.GroupWhereInput = {
    ...(filter.courseId === undefined ? {} : { courseId: filter.courseId }),
    ...(filter.branchId === undefined ? {} : { branchId: filter.branchId }),
  };

  const leftAt: Prisma.DateTimeFilter = {
    ...(filter.from === undefined ? {} : { gte: filter.from }),
    ...(filter.to === undefined ? {} : { lt: filter.to }),
  };

  return {
    status: GroupStudentStatus.LEFT,
    ...(filter.groupId === undefined ? {} : { groupId: filter.groupId }),
    ...(Object.keys(group).length === 0 ? {} : { group }),
    ...(Object.keys(leftAt).length === 0 ? {} : { statusChangedAt: leftAt }),
    ...(filter.search === undefined
      ? {}
      : {
          OR: [
            { student: { firstName: { contains: filter.search, mode: 'insensitive' } } },
            { student: { lastName: { contains: filter.search, mode: 'insensitive' } } },
            { student: { phone: { contains: filter.search } } },
            // Причина ухода — свободный текст (ТЗ 5.12), и искать по ней
            // осмысленно: «все, кто ушёл из-за переезда» — обычный вопрос
            // к этому отчёту, а сгруппировать её нечем.
            { statusReason: { contains: filter.search, mode: 'insensitive' } },
          ],
        }),
  };
};

/**
 * Доступ к данным витрины покинувших курсы (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — раскладку по месяцам и разрезам считает сервис
 * чистыми функциями из `left-courses.ts`.
 */
@Injectable()
export class LeftCoursesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: LeftCourseListParams): Promise<{ rows: LeftCourseRow[]; total: number }> {
    const where = whereOf(params);

    // Дата ухода может быть пустой у строк, закрытых до появления правила
    // (или правкой БД), и такие уходы — не «самые ранние»: `nulls: 'last'`
    // при любом направлении, как у вместимости аудитории (0007) и даты
    // приёма сотрудника (0020).
    const orderBy: Prisma.GroupStudentOrderByWithRelationInput[] =
      params.sort === LeftCourseSortField.Name
        ? [{ student: { lastName: params.order } }, { student: { firstName: params.order } }]
        : [{ statusChangedAt: { sort: params.order, nulls: 'last' } }];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.groupStudent.findMany({
        where,
        select: LEFT_COURSE_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.groupStudent.count({ where }),
    ]);

    return { rows, total };
  }

  /**
   * Уходы периода для статистики — **без окна страницы и без потолка**.
   *
   * Усечение дало бы тихо неверные счётчики, а это хуже медленного ответа
   * (то же решение, что у рейтинга в сессиях 0019 и 0024). Размер выборки
   * ограничен не потолком строк, а длиной периода: без параметров это последний
   * год, максимум — `MAX_STATS_MONTHS`.
   */
  findFacts(filter: LeftCourseFilter): Promise<LeftCourseFactRow[]> {
    return this.prisma.groupStudent.findMany({
      where: whereOf(filter),
      select: LEFT_COURSE_FACT_SELECT,
    });
  }
}
