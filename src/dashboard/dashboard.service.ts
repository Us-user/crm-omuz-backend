import { BadRequestException, Injectable } from '@nestjs/common';
import { GroupStatus, LeadType, StudentStatus } from '@prisma/client';

import {
  formatIsoDate,
  formatIsoMonth,
  monthSequence,
  nextIsoMonth,
  parseIsoDate,
  parseIsoMonth,
  shiftIsoMonth,
} from '../common';
import { employmentCountsOf } from '../graduates/graduates';
import type { LeftCourseFact } from '../left-courses/left-courses';
import { summarize } from '../left-courses/left-courses';
import type { LeadFact } from './dashboard';
import {
  compareMoney,
  countByMonth,
  DEFAULT_DASHBOARD_MONTHS,
  MAX_DASHBOARD_MONTHS,
  monthlyAttendance,
  summarizeEmployment,
  summarizeLeads,
  tallyAttendance,
} from './dashboard';
import { DashboardRepository } from './dashboard.repository';
import type {
  DashboardAttendanceDto,
  DashboardGraduatesDto,
  DashboardIncomeDto,
  DashboardIncomeQueryDto,
  DashboardLeadsDto,
  DashboardLeftCoursesDto,
  DashboardPeriodDto,
  DashboardPeriodQueryDto,
  DashboardSummaryDto,
  DashboardSummaryQueryDto,
} from './dto';

/** Разобранный период витрины: оба конца — первые числа месяцев, включительно. */
interface Period {
  from: Date;
  to: Date;
}

/**
 * Дашборд (ТЗ 5.2) — сводная витрина центра.
 *
 * Своих таблиц нет и не будет: это агрегатор поверх журнала (0018), лидов
 * (0027), кассы (0029–0032), выпускников (0026) и оттока (0025). Ни одна
 * витрина ничего не меняет, поэтому у модуля нет ни `POST`, ни `PUT` — как
 * у покинувших курсы (0025), общего расписания (0034) и обзора бухгалтерии
 * (0030).
 *
 * Шесть маршрутов, а не один сводный (решение пользователя): так их перечисляет
 * ТЗ 5.2, и у блоков **разная природа периода** — у сводки это день, у дохода
 * календарный месяц, у графиков отрезок месяцев. Один период на всех был бы
 * тихо неверен хотя бы для одного блока.
 *
 * Правила через границу модуля переходят **чистыми функциями**, а не сервисами:
 * отток сводит `summarize` из витрины покинувших, счётчики трудоустройства —
 * `employmentCountsOf` из выпускников, «опоздание — приход» — `isArrival`
 * из журнала. Второй способ посчитать те же числа разошёлся бы с первым,
 * и дашборд показывал бы не то, что экран, на который с него переходят.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly repository: DashboardRepository) {}

  /**
   * Сводка (ТЗ 5.2: «посещаемость за день, счётчики активных студентов/менторов,
   * активные группы»).
   *
   * Посещаемость относится к выбранному дню, а счётчики — к настоящему моменту:
   * «сколько сейчас активных групп» — вопрос о сегодня, и подставлять в него
   * прошлое значило бы обещать историю, которой система не хранит (статус
   * группы не версионируется — 0008, категория активности не хранится — 0019).
   */
  async summary(query: DashboardSummaryQueryDto): Promise<DashboardSummaryDto> {
    const date = query.date === undefined ? todayUtc() : parseIsoDate(query.date, 'date');

    const [lessons, marks, students, groups, mentors] = await Promise.all([
      this.repository.countLessonsOn(date),
      this.repository.aggregateAttendanceOn(date),
      this.repository.countStudentsByStatus(),
      this.repository.countGroupsByStatus(),
      this.repository.countActiveMentors(),
    ]);

    const studentOf = counterOf<StudentStatus>(students);
    const groupOf = counterOf<GroupStatus>(groups);

    return {
      date: formatIsoDate(date),
      attendance: { lessons, ...tallyAttendance(marks) },
      students: {
        active: studentOf(StudentStatus.ACTIVE),
        noActive: studentOf(StudentStatus.NO_ACTIVE),
        finished: studentOf(StudentStatus.FINISHED),
        blocked: studentOf(StudentStatus.BLOCK),
        total: totalOf(students),
      },
      mentors: { active: mentors },
      groups: {
        recruiting: groupOf(GroupStatus.RECRUITING),
        active: groupOf(GroupStatus.ACTIVE),
        finished: groupOf(GroupStatus.FINISHED),
        cancelled: groupOf(GroupStatus.CANCELLED),
        total: totalOf(groups),
      },
    };
  }

  /**
   * График посещаемости (ТЗ 5.2: «график Attendance (Late/Absent)»).
   *
   * Итог по периоду считается **той же** `tallyAttendance`, что и каждый
   * столбец: складывать проценты столбцов было бы неверно (месяцы разной
   * длины), а второе правило рядом с первым разошлось бы с ним.
   */
  async attendance(query: DashboardPeriodQueryDto): Promise<DashboardAttendanceDto> {
    const period = this.period(query.from, query.to);
    const months = monthSequence(period.from, period.to);

    const facts = await this.repository.findAttendanceFacts(period.from, nextIsoMonth(period.to));

    return {
      period: periodDto(period, months.length),
      totals: tallyAttendance(facts),
      byMonth: monthlyAttendance(months, facts),
    };
  }

  /** Воронка обращений (ТЗ 5.2: «статистика лидов»). */
  async leads(query: DashboardPeriodQueryDto): Promise<DashboardLeadsDto> {
    const period = this.period(query.from, query.to);
    const months = monthSequence(period.from, period.to);

    const rows = await this.repository.findLeadFacts(period.from, nextIsoMonth(period.to));

    const facts: LeadFact[] = rows.map((row) => ({
      at: row.createdAt,
      client: row.type === LeadType.CLIENT,
      converted: row.convertedStudentId !== null,
      utmSource: row.utmSource,
      course: row.course === null ? null : { id: row.course.id, name: row.course.title },
    }));

    const summary = summarizeLeads(facts, months);

    return {
      period: periodDto(period, months.length),
      totals: summary.totals,
      byMonth: summary.byMonth,
      byUtmSource: summary.byUtmSource,
      byCourse: summary.byCourse,
    };
  }

  /**
   * Доход за месяц со сравнением (ТЗ 5.2).
   *
   * Месяц календарный, и приход считается **по дню платежа** — это касса,
   * а не выставленные счета: неоплаченный месяц сюда не попадает, а предоплата
   * попадает (различие плана и кассы, решение 0030). Начислений здесь нет
   * намеренно — они отвечают на другой вопрос и уже есть в обзоре бухгалтерии.
   */
  async income(query: DashboardIncomeQueryDto): Promise<DashboardIncomeDto> {
    const month =
      query.month === undefined ? currentMonthStart() : parseIsoMonth(query.month, 'month');
    const previous = shiftIsoMonth(month, -1);

    const [income, expense, salary, prevIncome, prevExpense, prevSalary] = await Promise.all([
      this.repository.sumIncome(month, nextIsoMonth(month)),
      this.repository.sumExpense(month, nextIsoMonth(month)),
      this.repository.sumSalary(month, nextIsoMonth(month)),
      this.repository.sumIncome(previous, month),
      this.repository.sumExpense(previous, month),
      this.repository.sumSalary(previous, month),
    ]);

    return {
      month: formatIsoMonth(month),
      previousMonth: formatIsoMonth(previous),
      income: compareMoney(income, prevIncome),
      expense: compareMoney(expense, prevExpense),
      salary: compareMoney(salary, prevSalary),
      // Итог считается в тыйинах и переводится один раз: вычитание округлённых
      // сомони разошлось бы со слагаемыми на копейки (правило 0029).
      net: compareMoney(income - expense - salary, prevIncome - prevExpense - prevSalary),
    };
  }

  /** Блок «Employed graduates» (ТЗ 5.2). */
  async graduates(query: DashboardPeriodQueryDto): Promise<DashboardGraduatesDto> {
    const period = this.period(query.from, query.to);
    const months = monthSequence(period.from, period.to);

    const rows = await this.repository.findGraduateFacts(period.from, nextIsoMonth(period.to));

    // Счётчики сводит **та же** функция, что и `meta.employment` у `/graduates`
    // (0026): два экрана обязаны показывать одно число по определению.
    const summary = summarizeEmployment(
      employmentCountsOf(rows.map((row) => ({ employment: row.employment, count: 1 }))),
    );

    return {
      period: periodDto(period, months.length),
      total: summary.total,
      employment: summary.employment,
      employed: summary.employed,
      employmentRate: summary.employmentRate,
      byMonth: countByMonth(
        months,
        rows.map((row) => row.graduatedAt),
      ),
    };
  }

  /**
   * Блок «Left courses» (ТЗ 5.2).
   *
   * Считается **той же** `summarize`, что и `GET /left-courses/stats` (0025),
   * а в ответ идут три поля из пяти: дашборд отвечает «сколько и куда смотреть»,
   * разрезы по группам и филиалам остаются детальному экрану. Второй способ
   * считать отток разошёлся бы с первым — а это отчёт, по которому оценивают
   * работу центра.
   */
  async leftCourses(query: DashboardPeriodQueryDto): Promise<DashboardLeftCoursesDto> {
    const period = this.period(query.from, query.to);
    const months = monthSequence(period.from, period.to);

    const rows = await this.repository.findLeftCourseFacts(period.from, nextIsoMonth(period.to));

    const summary = summarize(
      rows.flatMap((row): LeftCourseFact[] =>
        // Уход без даты в статистику не идёт: его не в какой месяц класть
        // (то же правило, что в витрине покинувших).
        row.statusChangedAt === null
          ? []
          : [
              {
                leftAt: row.statusChangedAt,
                group: { id: row.group.id, name: row.group.name },
                course: { id: row.group.course.id, name: row.group.course.title },
                branch: { id: row.group.branch.id, name: row.group.branch.name },
              },
            ],
      ),
      months,
    );

    return {
      period: periodDto(period, months.length),
      total: summary.total,
      byMonth: summary.byMonth,
      byCourse: summary.byCourse,
    };
  }

  /**
   * Период витрины: у графика оси не бывает открытой, поэтому недостающие концы
   * достраиваются — `to` до текущего месяца, `from` на год назад от `to`
   * (то же решение, что у статистики оттока 0025 и обзора 0030).
   */
  private period(from?: string, to?: string): Period {
    const end = to === undefined ? currentMonthStart() : parseIsoMonth(to, 'to');
    const start =
      from === undefined
        ? shiftIsoMonth(end, -(DEFAULT_DASHBOARD_MONTHS - 1))
        : parseIsoMonth(from, 'from');

    if (start.getTime() > end.getTime()) {
      throw new BadRequestException({
        message: 'Начало периода позже его конца',
        details: { from: formatIsoMonth(start), to: formatIsoMonth(end) },
      });
    }

    const months = monthSequence(start, end).length;
    if (months > MAX_DASHBOARD_MONTHS) {
      throw new BadRequestException({
        message: `Слишком длинный период: максимум ${String(MAX_DASHBOARD_MONTHS)} месяцев`,
        details: { months, from: formatIsoMonth(start), to: formatIsoMonth(end) },
      });
    }

    return { from: start, to: end };
  }
}

const periodDto = (period: Period, months: number): DashboardPeriodDto => ({
  from: formatIsoMonth(period.from),
  to: formatIsoMonth(period.to),
  months,
});

/** Счётчик по статусу из строк `groupBy`: отсутствующий статус — это ноль. */
const counterOf =
  <T extends string>(rows: readonly { status: T; count: number }[]) =>
  (status: T): number =>
    rows.find((row) => row.status === status)?.count ?? 0;

const totalOf = (rows: readonly { count: number }[]): number =>
  rows.reduce((total, row) => total + row.count, 0);

/** «Сегодня» в UTC, как и весь проект (0021, 0023, 0024, 0034). */
const todayUtc = (): Date => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

const currentMonthStart = (): Date => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
};
