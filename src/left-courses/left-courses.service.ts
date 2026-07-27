import { BadRequestException, Injectable } from '@nestjs/common';

import { formatIsoMonth, nextIsoMonth, Paginated, parseIsoMonth, shiftIsoMonth } from '../common';
import type {
  LeftCourseDto,
  LeftCoursesQueryDto,
  LeftCoursesStatsDto,
  LeftCoursesStatsQueryDto,
} from './dto';
import type { LeftCourseFact } from './left-courses';
import { DEFAULT_STATS_MONTHS, MAX_STATS_MONTHS, monthSequence, summarize } from './left-courses';
import type { LeftCourseFactRow, LeftCourseRow } from './left-courses.repository';
import { LeftCoursesRepository } from './left-courses.repository';

/** Разобранный отрезок отчёта: оба конца — первые числа месяцев, включительно. */
interface Period {
  from: Date;
  to: Date;
}

/**
 * Границы для запроса: левая включающая, правая **не** включающая (первое число
 * следующего месяца). Любая из них может отсутствовать — у списка период
 * необязателен, и открытый конец остаётся открытым.
 */
interface PeriodBounds {
  from?: Date;
  toExclusive?: Date;
}

/**
 * Покинувшие курсы (ТЗ 5.12).
 *
 * Витрина поверх состава групп: своей модели у неё нет. «Покинул курс» — это
 * членство `GroupStudent` со статусом `LEFT`, причиной и датой (решение сессии
 * 0012), а `LeftCourse` из карты сущностей ТЗ 4 стал бы вторым источником
 * истины о тех же строках — тот же разбор, что с `Enrollment` (0012),
 * `Role` (0005) и `Performance` (0019).
 *
 * Единица отчёта — **покинутый курс**, а не человек. ТЗ 5.12 описывает витрину
 * как «студенты со статусом No Active», и в обычном случае это одно и то же:
 * уход из единственной группы переводит профиль в `NO_ACTIVE` (правило сессии
 * 0014). Но у того, кто ушёл с одного курса и продолжает на другом, профиль
 * остаётся `ACTIVE`, — и его уход всё равно обязан быть в отчёте по оттоку,
 * иначе центр недосчитался бы брошенных курсов. Статус профиля при этом
 * стоит в каждой строке, так что «кто не учится совсем» видно глазами,
 * а точный список даёт `GET /students?status=NO_ACTIVE`.
 */
@Injectable()
export class LeftCoursesService {
  constructor(private readonly repository: LeftCoursesRepository) {}

  /** Список покинувших (ТЗ 5.12: «вид Students»). */
  async findAll(query: LeftCoursesQueryDto): Promise<Paginated<LeftCourseDto>> {
    const bounds = this.optionalBounds(query.from, query.to);

    const { rows, total } = await this.repository.findMany({
      groupId: query.groupId,
      courseId: query.courseId,
      branchId: query.branchId,
      from: bounds.from,
      to: bounds.toExclusive,
      search: query.search,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toDto), total, query);
  }

  /**
   * Помесячный график и разрезы (ТЗ 5.12).
   *
   * Период по умолчанию — последний год, считая текущий месяц: без границ отчёт
   * читал бы всю историю центра, а «помесячный график» за пять лет не является
   * графиком. Обе границы при этом можно задать явно.
   */
  async stats(query: LeftCoursesStatsQueryDto): Promise<LeftCoursesStatsDto> {
    const period = this.statsPeriod(query.from, query.to);

    const rows = await this.repository.findFacts({
      groupId: query.groupId,
      courseId: query.courseId,
      branchId: query.branchId,
      from: period.from,
      to: nextIsoMonth(period.to),
    });

    const summary = summarize(rows.flatMap(toFact), monthSequence(period.from, period.to));

    return {
      from: formatIsoMonth(period.from),
      to: formatIsoMonth(period.to),
      total: summary.total,
      byMonth: summary.byMonth,
      byGroup: summary.byGroup,
      byCourse: summary.byCourse,
      byBranch: summary.byBranch,
    };
  }

  /**
   * Период списка: необязателен целиком, но заданные концы обязаны быть
   * по порядку. Открытая граница остаётся открытой — «всё до июня» и «всё
   * с января» законные запросы, и подставлять вторую границу самому значило бы
   * молча сужать выборку.
   */
  private optionalBounds(from?: string, to?: string): PeriodBounds {
    const start = from === undefined ? undefined : parseIsoMonth(from, 'from');
    const end = to === undefined ? undefined : parseIsoMonth(to, 'to');

    if (start !== undefined && end !== undefined) this.assertOrdered(start, end);

    return {
      from: start,
      toExclusive: end === undefined ? undefined : nextIsoMonth(end),
    };
  }

  /**
   * Период статистики: у графика оси не бывает открытой, поэтому недостающие
   * концы достраиваются — `to` до текущего месяца, `from` на год назад от `to`.
   */
  private statsPeriod(from?: string, to?: string): Period {
    const end = to === undefined ? currentMonthStart() : parseIsoMonth(to, 'to');
    const start =
      from === undefined
        ? shiftIsoMonth(end, -(DEFAULT_STATS_MONTHS - 1))
        : parseIsoMonth(from, 'from');

    this.assertOrdered(start, end);

    const months = monthSequence(start, end).length;
    if (months > MAX_STATS_MONTHS) {
      throw new BadRequestException({
        message: `Слишком длинный период: максимум ${String(MAX_STATS_MONTHS)} месяцев`,
        details: { months, from: formatIsoMonth(start), to: formatIsoMonth(end) },
      });
    }

    return { from: start, to: end };
  }

  private assertOrdered(from: Date, to: Date): void {
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException({
        message: 'Начало периода позже его конца',
        details: { from: formatIsoMonth(from), to: formatIsoMonth(to) },
      });
    }
  }
}

/**
 * Первое число текущего месяца (UTC).
 *
 * Часовой пояс центра (UTC+5) не учитывается намеренно: весь проект работает
 * с месяцами в UTC (`parseIsoMonth`, сессия 0021), и второе понятие «сейчас»
 * только здесь развело бы их. Следствие узкое — в первые часы первого числа
 * график по умолчанию заканчивается прошлым месяцем.
 */
const currentMonthStart = (): Date => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
};

const toDto = (row: LeftCourseRow): LeftCourseDto => ({
  student: row.student,
  group: { id: row.group.id, name: row.group.name },
  course: { id: row.group.course.id, name: row.group.course.title },
  branch: row.group.branch,
  mentor: row.mentorAtLeave,
  reason: row.statusReason,
  leftAt: row.statusChangedAt === null ? null : row.statusChangedAt.toISOString(),
  enrolledAt: row.enrolledAt.toISOString(),
});

/**
 * Факт для статистики. Уход без даты в график не попадает: положить его
 * не в какой месяц, а придумывать ему месяц значило бы сдвинуть отчёт.
 * В выборку периода такие строки и так не проходят — условие оставлено
 * ради честного типа и ради вызова без границ.
 */
const toFact = (row: LeftCourseFactRow): LeftCourseFact[] =>
  row.statusChangedAt === null
    ? []
    : [
        {
          leftAt: row.statusChangedAt,
          group: { id: row.group.id, name: row.group.name },
          course: { id: row.group.course.id, name: row.group.course.title },
          branch: row.group.branch,
        },
      ];
