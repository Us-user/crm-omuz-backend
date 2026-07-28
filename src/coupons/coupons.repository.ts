import { Injectable } from '@nestjs/common';
import type { DirectoryStatus, Prisma } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { CouponSortField } from './dto';

/**
 * Строка купона (ТЗ 5.7). Курсы отдаются вместе с ней: их у купона единицы,
 * а без них строка не отвечает на главный вопрос экрана — на что скидка.
 * Лиды же считаются счётчиком: их могут быть сотни, а на карточке нужно число.
 */
const COUPON_SELECT = {
  id: true,
  name: true,
  description: true,
  amount: true,
  validFrom: true,
  validTo: true,
  status: true,
  createdAt: true,
  courses: {
    select: { course: { select: { id: true, title: true } } },
    orderBy: { course: { title: 'asc' } },
  },
  _count: { select: { leads: true } },
} satisfies Prisma.CouponSelect;

export type CouponRow = Prisma.CouponGetPayload<{ select: typeof COUPON_SELECT }>;

export interface CouponListParams {
  search?: string;
  status?: DirectoryStatus;
  courseId?: string;
  /** «Действует сегодня»: `on` — дата, с которой сверяется период. */
  currentlyValid?: boolean;
  on: Date;
  sort: CouponSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface CouponWriteInput {
  name: string;
  description: string | null;
  amount: number;
  validFrom: Date | null;
  validTo: Date | null;
  status?: DirectoryStatus;
}

/** `undefined` — колонку не менять; значение (включая `null`) — записать. */
export type CouponUpdateInput = Partial<CouponWriteInput>;

/** Курс в том виде, в каком его проверяет мультивыбор купона. */
export interface CourseCandidate {
  id: string;
  title: string;
}

/**
 * Отбор «действует на дату»: статус `ACTIVE` и дата внутри периода. Обе границы
 * необязательны, и незаданная означает открытый конец — поэтому условие пишется
 * через `OR` с `null`, а не отрицанием: `NOT` у необязательной колонки
 * отбрасывает пустые значения, и бессрочные акции пропали бы молча (ровно та же
 * ловушка, что с `onlyMine` в кабинете ментора, 0023).
 */
const validOn = (on: Date): Prisma.CouponWhereInput => ({
  status: 'ACTIVE',
  AND: [
    { OR: [{ validFrom: null }, { validFrom: { lte: on } }] },
    { OR: [{ validTo: null }, { validTo: { gte: on } }] },
  ],
});

/**
 * Условия собираются в массив `AND`, а не в один объект: и «действует сегодня»,
 * и поиск приносят собственные `OR`/`AND`, и при склейке через spread второй
 * молча затёр бы первый — фильтр перестал бы фильтровать, ничем себя не выдав.
 */
const whereOf = (params: CouponListParams): Prisma.CouponWhereInput => {
  const conditions: Prisma.CouponWhereInput[] = [];

  if (params.status !== undefined) conditions.push({ status: params.status });

  // Купон «на все курсы» (пустой набор) действует и на этот курс тоже.
  if (params.courseId !== undefined) {
    conditions.push({
      OR: [{ courses: { some: { courseId: params.courseId } } }, { courses: { none: {} } }],
    });
  }

  if (params.currentlyValid !== undefined) {
    const valid = validOn(params.on);
    conditions.push(params.currentlyValid ? valid : { NOT: valid });
  }

  if (params.search !== undefined) {
    conditions.push({
      OR: [
        { name: { contains: params.search, mode: 'insensitive' } },
        { description: { contains: params.search, mode: 'insensitive' } },
      ],
    });
  }

  return conditions.length === 0 ? {} : { AND: conditions };
};

/**
 * Доступ к данным купонов (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — «действует ли сегодня» для показа считает сервис.
 */
@Injectable()
export class CouponsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: CouponListParams): Promise<{ rows: CouponRow[]; total: number }> {
    const where = whereOf(params);

    // Ключ `orderBy` собирается ветвлением, а не из строки: вычисляемое поле
    // прошло бы типизацию Prisma и упало бы уже в БД.
    const orderBy: Prisma.CouponOrderByWithRelationInput =
      params.sort === CouponSortField.Amount
        ? { amount: params.order }
        : params.sort === CouponSortField.ValidTo
          ? // Бессрочный купон — не «самый ранний» и не «самый поздний»:
            // пустая граница уезжает в конец при любом направлении, как
            // вместимость аудитории (0007) и балл выпускника (0026).
            { validTo: { sort: params.order, nulls: 'last' } }
          : params.sort === CouponSortField.CreatedAt
            ? { createdAt: params.order }
            : { name: params.order };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.coupon.findMany({
        where,
        select: COUPON_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.coupon.count({ where }),
    ]);

    return { rows, total };
  }

  findById(id: string): Promise<CouponRow | null> {
    return this.prisma.coupon.findUnique({ where: { id }, select: COUPON_SELECT });
  }

  /**
   * Поиск тёзки без учёта регистра. Уникальный индекс регистр учитывает, но
   * «OSEN-2026» и «osen-2026» человек читает как один и тот же купон.
   */
  findByName(name: string): Promise<{ id: string; name: string } | null> {
    return this.prisma.coupon.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
  }

  /** Какие из присланных курсов существуют — из разницы выводится 422. */
  findCourses(ids: string[]): Promise<CourseCandidate[]> {
    if (ids.length === 0) return Promise.resolve([]);

    return this.prisma.course.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true },
    });
  }

  /**
   * Создание купона вместе с мультивыбором курсов — **одной транзакцией**:
   * купон, заведённый без обещанного набора курсов, действовал бы «на все»
   * (правило пустого набора), то есть был бы шире, чем его создавали (ТЗ 7).
   */
  create(input: CouponWriteInput, courseIds: string[]): Promise<CouponRow> {
    return this.prisma.$transaction(async (tx) => {
      const coupon = await tx.coupon.create({ data: input, select: { id: true } });

      if (courseIds.length > 0) {
        await tx.couponCourse.createMany({
          data: courseIds.map((courseId) => ({ couponId: coupon.id, courseId })),
        });
      }

      return tx.coupon.findUniqueOrThrow({ where: { id: coupon.id }, select: COUPON_SELECT });
    });
  }

  /**
   * Правка. `courseIds === undefined` — мультивыбор не трогать; переданный
   * список заменяет набор целиком (иначе снять курс было бы нечем).
   */
  update(id: string, input: CouponUpdateInput, courseIds?: string[]): Promise<CouponRow> {
    return this.prisma.$transaction(async (tx) => {
      // `undefined` Prisma пропускает: не переданное поле остаётся прежним.
      await tx.coupon.update({ where: { id }, data: input });

      if (courseIds !== undefined) {
        await tx.couponCourse.deleteMany({ where: { couponId: id } });
        if (courseIds.length > 0) {
          await tx.couponCourse.createMany({
            data: courseIds.map((courseId) => ({ couponId: id, courseId })),
          });
        }
      }

      return tx.coupon.findUniqueOrThrow({ where: { id }, select: COUPON_SELECT });
    });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.coupon.delete({ where: { id } });
  }
}
