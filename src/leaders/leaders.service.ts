import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import {
  BusinessRuleException,
  formatIsoMonth,
  nextIsoMonth,
  Paginated,
  parseIsoMonth,
  SortOrder,
} from '../common';
import {
  ACTIVITY_CATEGORY_TITLES,
  ActivityCategory,
  activityCategoryOf,
  roundScore,
} from '../performance/performance';
import type {
  CloseMonthDto,
  LeaderDto,
  LeadersQueryDto,
  MonthWinnersDto,
  MonthWinnersRemovedDto,
  MonthlyWinnerDto,
  WinnersQueryDto,
} from './dto';
import type { RankedStudent } from './leaders';
import { rankByScore, takePlaces } from './leaders';
import type { LeaderStudentRow, MonthlyWinnerRow } from './leaders.repository';
import { LeadersRepository } from './leaders.repository';

/**
 * Сколько мест показывать отдельным блоком «топ-3» (ТЗ 5.13). При ничьей
 * на третьем месте строк будет больше трёх — и это правильно: срез идёт
 * по месту, а не по числу строк.
 */
const TOP_PLACES = 3;

/**
 * Лидеры и рейтинг центра (ТЗ 5.13).
 *
 * Витрина поверх журнала: своих данных, кроме снимков месяца, у неё нет.
 * Балл — среднее `Sum` по финализированным неделям (ТЗ 5.8, решение сессии 0019),
 * место — «сколько строго выше, плюс один», корона — место №1.
 *
 * Два разных ответа на два разных вопроса:
 *   - `GET /leaders` — **живой** рейтинг: считается на каждый запрос, поэтому
 *     правка журнала видна сразу. В него идут только те, кто учится сейчас,
 *     иначе корона навсегда осталась бы у выпускника прошлого года;
 *   - `GET /leaders/winners` — **снимок** месяца: хранится в `MonthlyWinner`
 *     и не пересчитывается. Здесь фильтра «учится сейчас» нет: снимок отвечает,
 *     кто учился лучше всех тогда.
 */
@Injectable()
export class LeadersService {
  private readonly logger = new Logger(LeadersService.name);

  constructor(private readonly repository: LeadersRepository) {}

  /**
   * Рейтинг центра (ТЗ 5.13: «топ-3, список, корона»).
   *
   * Места считаются по **всему** списку, а страница нарезается уже из него:
   * «сколько строго выше» нельзя ответить, прочитав двадцать строк.
   * Топ-3 уходит в `meta` — он один на все страницы, и на второй странице
   * экран не должен терять пьедестал (тот же приём, что с балансом коинов
   * в `meta.balance`, сессия 0018).
   */
  async findAll(query: LeadersQueryDto): Promise<Paginated<LeaderDto>> {
    const scores = await this.repository.findScores({
      groupId: query.groupId,
      courseId: query.courseId,
    });

    const ranked = rankByScore(scores);
    // `asc` показывает рейтинг снизу — отстающих. Места при этом остаются
    // настоящими: переворачивается порядок показа, а не нумерация.
    const ordered = query.order === SortOrder.Asc ? [...ranked].reverse() : ranked;
    const page = ordered.slice(query.skip, query.skip + query.take);
    const top = takePlaces(ranked, TOP_PLACES);

    // Профили запрашиваются один раз на страницу — вместе с пьедесталом,
    // который в неё может и не попасть.
    const students = await this.repository.findStudents(
      unique([...page, ...top].map(({ studentId }) => studentId)),
    );

    const toDto = leaderDtoOf(students);

    return Paginated.from(page.map(toDto), ranked.length, query, { top: top.map(toDto) });
  }

  /**
   * Победители месяца (ТЗ 5.13: «Winners of the last month (снимок месяца)»).
   *
   * Без параметра отдаётся последний **закрытый** месяц. Незакрытый месяц —
   * это `closed: false` и пустой список, а не 404: месяц, который ещё не
   * закрывали, — законное состояние, и подставлять вместо снимка расчёт
   * на лету значило бы выдать за снимок то, что снимком не является.
   */
  async findWinners(query: WinnersQueryDto): Promise<MonthWinnersDto> {
    const month =
      query.month === undefined
        ? await this.repository.findLatestClosedMonth()
        : parseIsoMonth(query.month, 'month');

    if (month === null) {
      return { month: null, closed: false, closedAt: null, closedBy: null, winners: [] };
    }

    const rows = await this.repository.findWinners(month);

    return winnersDtoOf(month, rows);
  }

  /**
   * Закрытие месяца — фиксация победителей (решение сессии 0024).
   *
   * Осознанное действие, как «Отправить результат» у недели журнала (ТЗ 5.8),
   * и с теми же последствиями: повторное закрытие отклоняется (409), потому
   * что второй снимок того же месяца означал бы два ответа на один вопрос.
   * Ошибочный снимок снимается `DELETE`, а не переписывается молча.
   */
  async closeMonth(dto: CloseMonthDto, accountId: string): Promise<MonthWinnersDto> {
    const month = parseIsoMonth(dto.month, 'month');

    // Снимок текущего месяца заморозил бы неполные данные — и «Winners of the
    // last month» в ТЗ 5.13 прямо говорит о прошедшем месяце.
    if (month.getTime() >= currentMonthStart().getTime()) {
      throw new BusinessRuleException(
        `Месяц ${dto.month} ещё не закончился: победителей фиксируют по завершившемуся месяцу`,
        { month: dto.month },
      );
    }

    const already = await this.repository.countWinners(month);
    if (already > 0) {
      throw new ConflictException(
        `Месяц ${dto.month} уже закрыт (${String(already)} строк снимка). ` +
          'Снимок не пересчитывается — снимите его, если он ошибочный',
      );
    }

    const scores = await this.repository.findMonthScores(month, nextIsoMonth(month));
    if (scores.length === 0) {
      throw new BusinessRuleException(
        `В месяце ${dto.month} нет ни одной финализированной недели — победителей не из кого выбирать`,
        { month: dto.month },
      );
    }

    const winners = takePlaces(rankByScore(scores), dto.places);
    const author = await this.repository.findEmployeeByAccount(accountId);

    const rows = await this.repository.createWinners(
      month,
      winners.map(({ studentId, place, average, weeksCount }) => ({
        studentId,
        place,
        // В снимок ложится **показанное** число: сравнения мест шли
        // по неокруглённому среднему, но хранить надо то, что видел человек.
        averageScore: roundScore(average),
        weeksCount,
      })),
      author?.id ?? null,
    );

    this.logger.log(
      `Месяц ${dto.month} закрыт: зафиксировано ${String(rows.length)} победителей ` +
        `(первых мест — ${String(dto.places)})`,
    );

    return winnersDtoOf(month, rows);
  }

  /**
   * Снятие снимка месяца. Маршрута нет в перечне ТЗ 5.13, но без него ошибочно
   * закрытый месяц остался бы навсегда: повторное закрытие отклоняется 409,
   * и вернуться в состояние «месяц не закрыт» было бы нечем. Право то же,
   * что у закрытия, — новых возможностей маршрут не даёт. Седьмой раз тот же
   * ход: `DELETE …/files/{fileId}` (0009), `PUT` роли ментора (0010), `DELETE`
   * из состава (0012), заметка о студенте (0015), уровень месяца (0021),
   * отзыв заявки на аванс (0022).
   */
  async reopenMonth(monthValue: string): Promise<MonthWinnersRemovedDto> {
    const month = parseIsoMonth(monthValue, 'month');
    const removed = await this.repository.deleteWinners(month);

    if (removed === 0) {
      throw new NotFoundException(`Месяц ${monthValue} не закрыт: снимка победителей нет`);
    }

    this.logger.log(`Снят снимок победителей за ${monthValue} (${String(removed)} строк)`);

    return { month: formatIsoMonth(month), removed };
  }
}

/**
 * Первое число текущего месяца (UTC).
 *
 * Часовой пояс центра (UTC+5) здесь не учитывается намеренно: весь проект
 * работает с месяцами в UTC (`parseIsoMonth`, сессия 0021), и второе понятие
 * «сейчас» только в этом месте развело бы их. Практическое следствие узкое —
 * в первые часы первого числа прошлый месяц ещё нельзя закрыть.
 */
const currentMonthStart = (): Date => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
};

const unique = (ids: string[]): string[] => [...new Set(ids)];

/**
 * Категория по баллу. `activityCategoryOf` отдаёт `null` только для
 * отсутствующего балла, а сюда попадают лишь строки с посчитанным средним, —
 * запасное значение недостижимо и стоит здесь ради честного типа.
 */
const categoryOf = (score: number): ActivityCategory =>
  activityCategoryOf(score) ?? ActivityCategory.BlackList;

/**
 * Строка рейтинга. Профиль подставляется из выборки страницы; если студента
 * в ней не оказалось (его удалили между двумя запросами), строка не выдумывает
 * имя — она просто не попадает в ответ.
 */
const leaderDtoOf =
  (students: LeaderStudentRow[]) =>
  (row: RankedStudent): LeaderDto => {
    const student = students.find(({ id }) => id === row.studentId);
    const score = roundScore(row.average);
    const category = categoryOf(row.average);

    return {
      position: row.place,
      isTopStudent: row.place === 1,
      student: {
        id: row.studentId,
        firstName: student?.firstName ?? '',
        lastName: student?.lastName ?? '',
        photoUrl: student?.photoUrl ?? null,
      },
      averageScore: score,
      category,
      categoryTitle: ACTIVITY_CATEGORY_TITLES[category],
      weeksCount: row.weeksCount,
      groups: (student?.groups ?? []).map(({ group }) => ({
        id: group.id,
        name: group.name,
        courseId: group.course.id,
        courseTitle: group.course.title,
      })),
    };
  };

/**
 * Снимок месяца. Кто и когда закрыл, берётся из первой строки: весь снимок
 * пишется одной транзакцией, поэтому у всех строк это одно и то же.
 */
const winnersDtoOf = (month: Date, rows: MonthlyWinnerRow[]): MonthWinnersDto => {
  const first = rows[0];

  return {
    month: formatIsoMonth(month),
    closed: rows.length > 0,
    closedAt: first === undefined ? null : first.createdAt.toISOString(),
    closedBy: first?.createdBy ?? null,
    winners: rows.map(winnerDtoOf),
  };
};

const winnerDtoOf = (row: MonthlyWinnerRow): MonthlyWinnerDto => {
  // `Prisma.Decimal` → число через `Number()`, а не `toNumber()`: так же
  // корректно, но не падает, если в слое данных лежит обычное число (0007).
  const score = Number(row.averageScore);
  const category = categoryOf(score);

  return {
    id: row.id,
    place: row.place,
    student: row.student,
    averageScore: score,
    weeksCount: row.weeksCount,
    category,
    categoryTitle: ACTIVITY_CATEGORY_TITLES[category],
  };
};
