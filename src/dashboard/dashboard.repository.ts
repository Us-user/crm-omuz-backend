import { Injectable } from '@nestjs/common';
import type { AttendanceMark, Prisma, StudentStatus } from '@prisma/client';
import { EmployeeStatus, GroupStatus, GroupStudentStatus } from '@prisma/client';

import { toCents } from '../accounting/accounting';
import { PrismaService } from '../prisma/prisma.service';

/** Отметка журнала вместе с датой занятия — вход помесячного графика. */
export interface AttendanceFactRow {
  at: Date;
  mark: AttendanceMark;
  count: number;
}

/** Обращение в том виде, в каком его читает воронка (ТЗ 5.2). */
const LEAD_FACT_SELECT = {
  createdAt: true,
  type: true,
  convertedStudentId: true,
  utmSource: true,
  course: { select: { id: true, title: true } },
} satisfies Prisma.LeadSelect;

export type LeadFactRow = Prisma.LeadGetPayload<{ select: typeof LEAD_FACT_SELECT }>;

/** Выпуск: дата — для графика, статус — для счётчиков трудоустройства. */
const GRADUATE_FACT_SELECT = {
  graduatedAt: true,
  employment: true,
} satisfies Prisma.GraduateSelect;

export type GraduateFactRow = Prisma.GraduateGetPayload<{ select: typeof GRADUATE_FACT_SELECT }>;

/**
 * Уход с курса — та же форма, что у витрины покинувших (0025): дашборд сводит
 * их **той же** чистой функцией `summarize`, поэтому и читать обязан то же.
 */
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

export type DashboardLeftCourseRow = Prisma.GroupStudentGetPayload<{
  select: typeof LEFT_COURSE_FACT_SELECT;
}>;

/**
 * Доступ к данным дашборда (`Controller → Service → Repository`).
 *
 * Бизнес-правил здесь нет — раскладки и доли считает сервис чистыми функциями
 * из `dashboard.ts`. Запросы **свои**, а не заимствованные у соседних модулей:
 * критерий сессии 0006 действует и здесь — зависимость от `AccountingRepository`
 * или `LeftCoursesRepository` заставила бы каждый e2e-набор дашборда подменять
 * репозитории, которыми он не пользуется. Через границу модуля переходят
 * **правила** (`summarize`, `employmentCountsOf`, `fromCents`, `isArrival`),
 * а не сервисы — тот же ход, что в 0014, 0018, 0019 и 0026.
 */
@Injectable()
export class DashboardRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────────── Сводка (ТЗ 5.2) ──────────────────────────────

  /** Сколько студентов в каждом статусе (ТЗ 5.3). */
  async countStudentsByStatus(): Promise<{ status: StudentStatus; count: number }[]> {
    const rows = await this.prisma.student.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    return rows.map(({ status, _count }) => ({ status, count: _count._all }));
  }

  /** Сколько групп в каждом статусе (ТЗ 5.5). */
  async countGroupsByStatus(): Promise<{ status: GroupStatus; count: number }[]> {
    const rows = await this.prisma.group.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    return rows.map(({ status, _count }) => ({ status, count: _count._all }));
  }

  /**
   * Действующие менторы — сотрудники, ведущие хотя бы одну живую группу.
   *
   * «Ментор» определён **менторством**, а не позицией: сессия 0010 отказалась
   * опирать правила на название позиции, потому что оно редактируется
   * администратором и `Mentor` не помечена `isSystem`. Счётчик дашборда,
   * построенный на переименуемой строке, однажды молча стал бы нулём.
   *
   * Отменённые и завершённые группы не в счёт: ментор завершённого курса
   * сейчас никого не ведёт.
   */
  countActiveMentors(): Promise<number> {
    return this.prisma.employee.count({
      where: {
        status: EmployeeStatus.ACTIVE,
        mentorGroups: {
          some: { group: { status: { in: [GroupStatus.ACTIVE, GroupStatus.RECRUITING] } } },
        },
      },
    });
  }

  /** Сколько учебных дней журнала заведено на дату — «занятий за день». */
  countLessonsOn(date: Date): Promise<number> {
    return this.prisma.journalDay.count({ where: { date } });
  }

  /**
   * Отметки посещаемости за один день (ТЗ 5.2: «посещаемость за день»).
   *
   * Неотмеченные клетки отсекаются запросом: «не отмечен» и «отсутствовал» —
   * разные состояния (0018), и тащить `null` в приложение, чтобы там его
   * выбросить, незачем.
   */
  async aggregateAttendanceOn(date: Date): Promise<{ mark: AttendanceMark; count: number }[]> {
    const rows = await this.prisma.journalEntry.groupBy({
      by: ['attendance'],
      where: { attendance: { not: null }, day: { date } },
      _count: { _all: true },
    });

    return rows.flatMap(({ attendance, _count }) =>
      attendance === null ? [] : [{ mark: attendance, count: _count._all }],
    );
  }

  // ──────────────────── График посещаемости за период (ТЗ 5.2) ────────────────

  /**
   * Отметки периода вместе с датой занятия.
   *
   * Считается **двумя** запросами, а не чтением каждой клетки: группировка
   * по `(dayId, attendance)` даёт не больше трёх строк на учебный день, тогда
   * как сами клетки — это «студенты × дни», то есть на порядок больше. Дату
   * при этом хранит день, а не клетка, поэтому она догружается вторым запросом
   * и подставляется здесь: помесячная группировка в Prisma не выражается
   * (нужен `date_trunc`, то есть сырой SQL, которого в проекте нет) — тот же
   * разбор, что в 0025, 0030 и 0033.
   */
  async findAttendanceFacts(from: Date, to: Date): Promise<AttendanceFactRow[]> {
    const days = await this.prisma.journalDay.findMany({
      where: { date: { gte: from, lt: to } },
      select: { id: true, date: true },
    });

    if (days.length === 0) return [];

    const dates = new Map(days.map((day) => [day.id, day.date]));

    const rows = await this.prisma.journalEntry.groupBy({
      by: ['dayId', 'attendance'],
      where: { attendance: { not: null }, dayId: { in: [...dates.keys()] } },
      _count: { _all: true },
    });

    return rows.flatMap(({ dayId, attendance, _count }) => {
      const at = dates.get(dayId);

      return attendance === null || at === undefined
        ? []
        : [{ at, mark: attendance, count: _count._all }];
    });
  }

  // ────────────────────────── Воронка лидов (ТЗ 5.2) ──────────────────────────

  /**
   * Обращения периода — без окна страницы и без потолка.
   *
   * Усечение дало бы тихо неверную воронку, а это хуже медленного ответа
   * (решение 0019, 0024, 0025, 0029). Размер выборки ограничен не числом строк,
   * а длиной периода: по умолчанию год, максимум `MAX_DASHBOARD_MONTHS`.
   */
  findLeadFacts(from: Date, to: Date): Promise<LeadFactRow[]> {
    return this.prisma.lead.findMany({
      where: { createdAt: { gte: from, lt: to } },
      select: LEAD_FACT_SELECT,
    });
  }

  // ─────────────────────────── Деньги месяца (ТЗ 5.2) ─────────────────────────

  /** Принятые за окно деньги, включая предоплаты, — касса (0029, 0030). */
  async sumIncome(from: Date, to: Date): Promise<number> {
    const sums = await this.prisma.paymentTransaction.aggregate({
      where: { paidAt: { gte: from, lt: to } },
      _sum: { amount: true },
    });

    return sums._sum.amount === null ? 0 : toCents(sums._sum.amount);
  }

  /** Расходы окна — **без зарплаты**: она стоит своим числом (0032). */
  async sumExpense(from: Date, to: Date): Promise<number> {
    const sums = await this.prisma.expense.aggregate({
      where: { spentAt: { gte: from, lt: to } },
      _sum: { amount: true },
    });

    return sums._sum.amount === null ? 0 : toCents(sums._sum.amount);
  }

  /** Выплаченная за окно зарплата — по дню выплаты (0032). */
  async sumSalary(from: Date, to: Date): Promise<number> {
    const sums = await this.prisma.salaryTransaction.aggregate({
      where: { paidAt: { gte: from, lt: to } },
      _sum: { amount: true },
    });

    return sums._sum.amount === null ? 0 : toCents(sums._sum.amount);
  }

  // ──────────────────────────── Выпускники (ТЗ 5.2) ───────────────────────────

  /**
   * Выпуски периода: дата и статус трудоустройства одной выборкой.
   *
   * Здесь осознанно **не** `groupBy`, в отличие от `GET /graduates` (0026, где
   * счётчики считает БД, чтобы не читать всех выпускников центра): дашборду
   * всё равно нужен помесячный ряд, а его без дат не построить — значит, строки
   * уже прочитаны, и второй запрос за счётчиками был бы запросом за тем, что
   * лежит в руках. Числа при этом не могут разойтись с карточкой выпускников:
   * их сводит **та же** чистая функция `employmentCountsOf`.
   */
  findGraduateFacts(from: Date, to: Date): Promise<GraduateFactRow[]> {
    return this.prisma.graduate.findMany({
      where: { graduatedAt: { gte: from, lt: to } },
      select: GRADUATE_FACT_SELECT,
    });
  }

  // ────────────────────────── Покинувшие курсы (ТЗ 5.2) ───────────────────────

  /**
   * Уходы периода. Отбор повторяет витрину покинувших (0025): статус `LEFT`,
   * а `TRANSFERRED` не в счёт — переведённый курс не покидал (0012), и один
   * статус на двоих завысил бы отток ровно на число внутренних переводов.
   */
  findLeftCourseFacts(from: Date, to: Date): Promise<DashboardLeftCourseRow[]> {
    return this.prisma.groupStudent.findMany({
      where: {
        status: GroupStudentStatus.LEFT,
        statusChangedAt: { gte: from, lt: to },
      },
      select: LEFT_COURSE_FACT_SELECT,
    });
  }
}
