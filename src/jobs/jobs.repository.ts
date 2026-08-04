import { Injectable } from '@nestjs/common';
import type { DirectoryStatus, Prisma } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { JobSortField } from './dto';

/**
 * Строка вакансии (ТЗ 5.18). Отдаётся целиком: у вакансии нет ни связей,
 * ни счётчиков — это самостоятельное объявление, а не узел справочника.
 */
const JOB_SELECT = {
  id: true,
  title: true,
  company: true,
  description: true,
  requirements: true,
  contacts: true,
  deadline: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.JobSelect;

export type JobRow = Prisma.JobGetPayload<{ select: typeof JOB_SELECT }>;

export interface JobListParams {
  search?: string;
  status?: DirectoryStatus;
  /** «Актуальна на дату»: `on` — день, с которым сверяется срок. */
  open?: boolean;
  on: Date;
  sort: JobSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface JobWriteInput {
  title: string;
  company: string;
  description: string | null;
  requirements: string | null;
  contacts: string;
  deadline: Date | null;
  status?: DirectoryStatus;
}

/** `undefined` — колонку не менять; значение (включая `null`) — записать. */
export type JobUpdateInput = Partial<JobWriteInput>;

/**
 * Отбор «актуальна на дату»: статус `ACTIVE` и срок не прошёл. Условие
 * по сроку пишется через `OR` с `null`, а не отрицанием: `NOT` у необязательной
 * колонки отбрасывает пустые значения, и бессрочные вакансии пропали бы молча
 * (та же ловушка, что с периодом купона, 0027, и с `onlyMine` кабинета
 * ментора, 0023).
 */
const openOn = (on: Date): Prisma.JobWhereInput => ({
  status: 'ACTIVE',
  OR: [{ deadline: null }, { deadline: { gte: on } }],
});

/**
 * Условия собираются в массив `AND`, а не в один объект: и «актуальна сегодня»,
 * и поиск приносят собственный `OR`, и при склейке через spread второй молча
 * затёр бы первый — фильтр перестал бы фильтровать, ничем себя не выдав (0027).
 */
const whereOf = (params: JobListParams): Prisma.JobWhereInput => {
  const conditions: Prisma.JobWhereInput[] = [];

  if (params.status !== undefined) conditions.push({ status: params.status });

  if (params.open !== undefined) {
    const open = openOn(params.on);
    conditions.push(params.open ? open : { NOT: open });
  }

  // Поиск идёт по всем четырём текстовым полям: название и компанию ищут чаще,
  // но «кто просил TypeScript» — такой же законный вопрос к списку объявлений
  // (тот же довод, что с поиском по причине ухода, 0025).
  if (params.search !== undefined) {
    conditions.push({
      OR: [
        { title: { contains: params.search, mode: 'insensitive' } },
        { company: { contains: params.search, mode: 'insensitive' } },
        { description: { contains: params.search, mode: 'insensitive' } },
        { requirements: { contains: params.search, mode: 'insensitive' } },
      ],
    });
  }

  return conditions.length === 0 ? {} : { AND: conditions };
};

/**
 * Доступ к данным вакансий (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — «актуальна ли сегодня» для показа считает сервис.
 */
@Injectable()
export class JobsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: JobListParams): Promise<{ rows: JobRow[]; total: number }> {
    const where = whereOf(params);

    // Ключ `orderBy` собирается ветвлением, а не из строки: вычисляемое поле
    // прошло бы типизацию Prisma и упало бы уже в БД (0027).
    const orderBy: Prisma.JobOrderByWithRelationInput =
      params.sort === JobSortField.Title
        ? { title: params.order }
        : params.sort === JobSortField.Company
          ? { company: params.order }
          : params.sort === JobSortField.Deadline
            ? // Бессрочная вакансия — не «самая ранняя» и не «самая поздняя»:
              // пустой срок уезжает в конец при любом направлении, как конец
              // периода купона (0027) и вместимость аудитории (0007).
              { deadline: { sort: params.order, nulls: 'last' } }
            : { createdAt: params.order };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.job.findMany({
        where,
        select: JOB_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.job.count({ where }),
    ]);

    return { rows, total };
  }

  findById(id: string): Promise<JobRow | null> {
    return this.prisma.job.findUnique({ where: { id }, select: JOB_SELECT });
  }

  create(input: JobWriteInput): Promise<JobRow> {
    return this.prisma.job.create({ data: input, select: JOB_SELECT });
  }

  /** `undefined` Prisma пропускает: не переданное поле остаётся прежним. */
  update(id: string, input: JobUpdateInput): Promise<JobRow> {
    return this.prisma.job.update({ where: { id }, data: input, select: JOB_SELECT });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.job.delete({ where: { id } });
  }
}
