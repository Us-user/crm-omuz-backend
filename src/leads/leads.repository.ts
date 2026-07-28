import { Injectable } from '@nestjs/common';
import type { Gender, LeadType, Prisma } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { LeadSortField } from './dto';
import type { ExistingStudentProfile, LeadForTransfer, LeadStudentProfile } from './leads-transfer';

/**
 * Строка лида (ТЗ 5.7). Курс, купон и филиал отдаются вместе со строкой:
 * список читают целиком, и догрузка каждой ссылки превратила бы одну таблицу
 * в сотню запросов (тот же приём, что в витрине выпускников, 0026).
 */
const LEAD_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  email: true,
  birthDate: true,
  gender: true,
  occupation: true,
  enrollMonth: true,
  lessonTimeMinute: true,
  notes: true,
  source: true,
  utmSource: true,
  utmMedium: true,
  utmCampaign: true,
  type: true,
  becameClientAt: true,
  convertedStudentId: true,
  convertedAt: true,
  createdAt: true,
  course: { select: { id: true, title: true } },
  coupon: { select: { id: true, name: true } },
  branch: { select: { id: true, name: true } },
} satisfies Prisma.LeadSelect;

export type LeadRow = Prisma.LeadGetPayload<{ select: typeof LEAD_SELECT }>;

/**
 * Поля обращения, из которых заводится профиль студента (ТЗ 5.7: «Transfer
 * в студенты»). Отдельный `select` от `LEAD_SELECT`: там ссылки отдаются
 * именованными объектами для экрана, а переводу нужен сам `branchId` —
 * его он пишет в новый профиль.
 */
const LEAD_TRANSFER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  email: true,
  birthDate: true,
  gender: true,
  branchId: true,
  convertedStudentId: true,
} satisfies Prisma.LeadSelect;

/**
 * Потолок выгрузки. Лидов в центре накапливается больше, чем студентов
 * в группе, но и здесь «выгрузить всё» не должно означать «прочитать сколько
 * угодно»: файл собирается в памяти целиком (та же граница, что в 0013).
 */
export const MAX_EXPORT_ROWS = 5000;

/**
 * Отбор лидов — общий для постраничного списка и для выгрузки: два экрана
 * одного набора обязаны отбирать одно и то же **по определению**, а не
 * по совпадению (приём сессий 0013 и 0025).
 *
 * `from`/`to` — уже разобранные границы периода обращения: `from` включающая,
 * `to` **не** включающая (первое число месяца, следующего за концом периода).
 */
export interface LeadFilter {
  type?: LeadType;
  courseId?: string;
  branchId?: string;
  couponId?: string;
  enrollMonth?: Date;
  converted?: boolean;
  from?: Date;
  to?: Date;
  search?: string;
}

export interface LeadListParams extends LeadFilter {
  sort: LeadSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface LeadWriteInput {
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  birthDate: Date | null;
  gender?: Gender | null;
  occupation: string | null;
  enrollMonth: Date | null;
  courseId: string | null;
  lessonTimeMinute: number | null;
  notes: string | null;
  source: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  couponId: string | null;
  branchId: string | null;
  type?: LeadType;
  becameClientAt?: Date | null;
}

/** `undefined` — колонку не менять; значение (включая `null`) — записать. */
export type LeadUpdateInput = Partial<LeadWriteInput>;

/**
 * Одна строка перевода, как её посчитал сервис (ТЗ 5.7).
 *
 * Решение «завести профиль или привязать существующий» принято до транзакции
 * чистой функцией `planLeadTransfers`: репозиторий его только выполняет.
 */
export interface LeadTransferWrite {
  leadId: string;
  /** Профиль, к которому привязывается обращение; `null` — завести новый. */
  studentId: string | null;
  /** Поля нового профиля; при `studentId !== null` не используются. */
  profile: LeadStudentProfile;
}

export interface LeadTransferResult {
  leadId: string;
  studentId: string;
}

const whereOf = (filter: LeadFilter): Prisma.LeadWhereInput => {
  const conditions: Prisma.LeadWhereInput[] = [];

  if (filter.type !== undefined) conditions.push({ type: filter.type });
  if (filter.courseId !== undefined) conditions.push({ courseId: filter.courseId });
  if (filter.branchId !== undefined) conditions.push({ branchId: filter.branchId });
  if (filter.couponId !== undefined) conditions.push({ couponId: filter.couponId });
  if (filter.enrollMonth !== undefined) conditions.push({ enrollMonth: filter.enrollMonth });

  // «Переведён» — это наличие ссылки на профиль: отдельный флаг был бы вторым
  // источником истины о том же (комментарий у модели в схеме).
  if (filter.converted !== undefined) {
    conditions.push({ convertedStudentId: filter.converted ? { not: null } : null });
  }

  if (filter.from !== undefined || filter.to !== undefined) {
    conditions.push({
      createdAt: {
        ...(filter.from === undefined ? {} : { gte: filter.from }),
        ...(filter.to === undefined ? {} : { lt: filter.to }),
      },
    });
  }

  if (filter.search !== undefined) {
    conditions.push({
      OR: [
        { firstName: { contains: filter.search, mode: 'insensitive' } },
        { lastName: { contains: filter.search, mode: 'insensitive' } },
        { phone: { contains: filter.search } },
        { email: { contains: filter.search, mode: 'insensitive' } },
        // Источник — свободный текст (ТЗ 5.7), группировать его нечем, поэтому
        // он попадает в поиск: «кто пришёл по рекомендации» — обычный вопрос
        // к списку (тот же ход, что с причиной ухода в отчёте по оттоку, 0025).
        { source: { contains: filter.search, mode: 'insensitive' } },
        { utmCampaign: { contains: filter.search, mode: 'insensitive' } },
      ],
    });
  }

  return conditions.length === 0 ? {} : { AND: conditions };
};

/**
 * Доступ к данным лидов (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — переходы стадии и разбор дат делает сервис.
 */
@Injectable()
export class LeadsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: LeadListParams): Promise<{ rows: LeadRow[]; total: number }> {
    const where = whereOf(params);

    // Ключ `orderBy` собирается ветвлением, а не из строки: вычисляемое поле
    // прошло бы типизацию Prisma и упало бы уже в БД.
    const orderBy: Prisma.LeadOrderByWithRelationInput[] =
      params.sort === LeadSortField.Name
        ? [{ lastName: params.order }, { firstName: params.order }]
        : params.sort === LeadSortField.EnrollMonth
          ? // Лид без месяца записи — не «самый ранний»: пустое значение уезжает
            // в конец при любом направлении (приём 0007, 0020, 0026).
            [{ enrollMonth: { sort: params.order, nulls: 'last' } }]
          : [{ createdAt: params.order }];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.lead.findMany({
        where,
        select: LEAD_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.lead.count({ where }),
    ]);

    return { rows, total };
  }

  findById(id: string): Promise<LeadRow | null> {
    return this.prisma.lead.findUnique({ where: { id }, select: LEAD_SELECT });
  }

  /**
   * Сколько **других** обращений с этим номером уже заведено. Не запрет,
   * а подсказка: телефон лида намеренно не уникален (см. схему).
   */
  countByPhone(phone: string, exceptId?: string): Promise<number> {
    return this.prisma.lead.count({
      where: { phone, ...(exceptId === undefined ? {} : { id: { not: exceptId } }) },
    });
  }

  create(input: LeadWriteInput): Promise<LeadRow> {
    return this.prisma.lead.create({ data: input, select: LEAD_SELECT });
  }

  update(id: string, input: LeadUpdateInput): Promise<LeadRow> {
    // `undefined` Prisma пропускает: не переданное поле остаётся прежним.
    return this.prisma.lead.update({ where: { id }, data: input, select: LEAD_SELECT });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.lead.delete({ where: { id } });
  }

  // ───────────────────── Выгрузка и перевод (ТЗ 5.7) ─────────────────────

  /**
   * Все отобранные лиды для выгрузки — без окна страницы, но с потолком:
   * файл собирается в памяти, и «выгрузить всё» не должно означать
   * «прочитать сколько угодно» (правило 0013).
   *
   * Отбор — тот же `whereOf`, что у постраничного списка: выгрузка и экран
   * обязаны показывать один набор по определению, а не по совпадению.
   *
   * Порядок фиксирован и дополнен `id`: у файла нет экрана с сортировкой,
   * а два запуска выгрузки должны давать одинаковые строки в одинаковом
   * порядке — иначе их нельзя сравнить между собой. Без второго ключа
   * обращения, заведённые в одну миллисекунду (импорт, тесты), меняли бы
   * места между запусками.
   */
  findAllForExport(filter: LeadFilter): Promise<LeadRow[]> {
    return this.prisma.lead.findMany({
      where: whereOf(filter),
      select: LEAD_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: MAX_EXPORT_ROWS,
    });
  }

  /**
   * Обращения из пачки перевода. Ненайденные просто не вернутся — сервис
   * назовёт их в отчёте (перечисляются **только** недостающие, правило 0009).
   */
  findManyForTransfer(ids: string[]): Promise<LeadForTransfer[]> {
    return this.prisma.lead.findMany({
      where: { id: { in: ids } },
      select: LEAD_TRANSFER_SELECT,
    });
  }

  /**
   * Профили студентов с этими телефонами. `Student.phone` уникален с Фазы 1,
   * поэтому номер однозначно указывает на человека — и на нём же держится
   * решение «привязать, а не завести второй профиль».
   *
   * `leadOrigin` — обращение, из которого профиль уже заведён: `Lead.convertedStudentId`
   * уникален, и занятый профиль привязать второй раз нельзя. Связь 1:1,
   * поэтому берётся сама ссылка, а не `_count`.
   */
  async findStudentsByPhones(phones: string[]): Promise<ExistingStudentProfile[]> {
    const students = await this.prisma.student.findMany({
      where: { phone: { in: phones } },
      select: {
        id: true,
        phone: true,
        lastName: true,
        firstName: true,
        leadOrigin: { select: { id: true } },
      },
    });

    return students.map(({ leadOrigin, ...student }) => ({
      ...student,
      leadOriginId: leadOrigin?.id ?? null,
    }));
  }

  /**
   * Перевод пачки одной транзакцией (ТЗ 5.7, ТЗ 7).
   *
   * Профили заводит **репозиторий лидов**, а не `StudentsService`: зависимость
   * от `StudentsModule` заставила бы каждый e2e-набор лидов подменять
   * репозиторий, которым он не пользуется (критерий сессии 0006), — так же
   * лиды уже читают курс, купон и филиал своим запросом. Валидацию полей
   * формы это не обходит: в профиль уходит только то, что у обращения уже
   * проверено при заведении (телефон в E.164, существующий филиал).
   *
   * Частичное применение здесь было бы хуже отказа: половина пачки, ставшая
   * студентами, оставила бы оператора с вопросом, какая именно половина, —
   * то же решение, что у импорта состава (0013) и зачисления пачкой (0012).
   */
  async transfer(writes: readonly LeadTransferWrite[], now: Date): Promise<LeadTransferResult[]> {
    return this.prisma.$transaction(async (tx) => {
      const results: LeadTransferResult[] = [];

      for (const write of writes) {
        const studentId =
          write.studentId ??
          (await tx.student.create({ data: write.profile, select: { id: true } })).id;

        await tx.lead.update({
          where: { id: write.leadId },
          data: { convertedStudentId: studentId, convertedAt: now },
        });

        results.push({ leadId: write.leadId, studentId });
      }

      return results;
    });
  }

  // ───────────────────────── Ссылки формы (ТЗ 5.7) ─────────────────────────

  /** Курс из формы. `null` — такого курса нет, сервис ответит 422. */
  findCourse(id: string): Promise<{ id: string; title: string } | null> {
    return this.prisma.course.findUnique({ where: { id }, select: { id: true, title: true } });
  }

  findCoupon(id: string): Promise<{ id: string; name: string } | null> {
    return this.prisma.coupon.findUnique({ where: { id }, select: { id: true, name: true } });
  }

  findBranch(id: string): Promise<{ id: string; name: string } | null> {
    return this.prisma.branch.findUnique({ where: { id }, select: { id: true, name: true } });
  }
}
