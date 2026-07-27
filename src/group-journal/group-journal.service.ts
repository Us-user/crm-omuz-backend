import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { GroupStudentStatus, LessonType } from '@prisma/client';
import {
  AttendanceMark,
  GroupStudentStatus as MembershipStatus,
  LessonType as DayType,
} from '@prisma/client';

import { BusinessRuleException, formatIsoDate, Paginated, parseIsoDate } from '../common';
import { coinsForWeekSum } from '../student-coins/coin-award';
import type {
  CreateJournalWeekDto,
  JournalDayInputDto,
  JournalQueryDto,
  JournalRowDto,
  JournalWeekDeletedDto,
  JournalWeekDto,
  JournalWeekSummaryDto,
  MarkAllPresentDto,
  MarkedAllPresentDto,
  UpdateJournalWeekDto,
  WeekCoinAwardDto,
  WeekSubmittedDto,
} from './dto';
import type {
  JournalGroup,
  RosterRow,
  StudentProfile,
  WeekAggregate,
  WeekCoinAward,
  WeekDayInput,
  WeekDetailRow,
  WeekEntryInput,
  WeekResultInput,
  WeekSummaryRow,
} from './group-journal.repository';
import { GroupJournalRepository } from './group-journal.repository';
import { computeWeekScore } from './journal-scoring';

/** Сколько суток охватывает неделя. */
const DAYS_IN_WEEK = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Ручные слагаемые студента за неделю. */
interface ManualScore {
  bonus: number;
  exam: number;
}

/** Клетка недели в памяти: день адресуется датой, а не ещё не выданным `id`. */
interface Cell {
  attendance: AttendanceMark | null;
  score: number | null;
}

/**
 * Итоговое состояние недели после применения правки — то, по которому считаются
 * `sum`. Дни здесь адресуются датой: на момент подсчёта у новых дней ещё нет
 * идентификаторов, а у старых они не обязаны сохраниться.
 */
interface WeekState {
  /** Дата (мс) → тип занятия. */
  dayTypes: Map<number, LessonType>;
  /** Студент → (дата (мс) → клетка). */
  cells: Map<string, Map<number, Cell>>;
  /** Студент → ручные слагаемые. */
  manual: Map<string, ManualScore>;
}

/**
 * Журнал группы (ТЗ 5.8: Progressbook) и автоначисление коинов (ТЗ 5.9).
 *
 * Правила модуля:
 *   - группа из пути должна существовать (404), неделя — принадлежать ей (404);
 *   - учебные дни задаёт оператор и они укладываются в семь суток от начала
 *     недели; один календарный день не принадлежит двум неделям группы (409);
 *   - отмечать можно только тех, кто состоит (или состоял) в группе (422);
 *   - **финализированная неделя не меняется** (422): на её итогах уже начислены
 *     коины, а списания в системе нет (ТЗ 5.9);
 *   - итог недели `Sum = Σ(приходы) + Σ(ДЗ) + Exam + Bonus`, и на экзамене
 *     приход не считается (ТЗ 5.8).
 *
 * `WeekResult.sum` — хранимое значение, но не второй источник истины: он
 * пересчитывается сервисом по итоговому состоянию недели и уходит в БД той же
 * транзакцией, что и сама правка. Наружу при этом всегда отдаётся пересчитанный
 * итог — если бы кэш когда-нибудь разошёлся с клетками, экран показал бы правду.
 */
@Injectable()
export class GroupJournalService {
  private readonly logger = new Logger(GroupJournalService.name);

  constructor(private readonly repository: GroupJournalRepository) {}

  /** Список недель журнала (ТЗ 5.8). Клетки в него не входят — их показывает карточка недели. */
  async findAll(
    groupId: string,
    query: JournalQueryDto,
  ): Promise<Paginated<JournalWeekSummaryDto>> {
    await this.requireGroup(groupId);

    const { rows, total } = await this.repository.findWeeks({
      groupId,
      submitted: query.submitted,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    const aggregates = await this.repository.aggregateWeeks(rows.map((row) => row.id));
    const byWeek = new Map(aggregates.map((item) => [item.weekId, item]));

    return Paginated.from(
      rows.map((row) => toSummaryDto(row, byWeek.get(row.id))),
      total,
      query,
    );
  }

  /** Неделя целиком: дни, состав и все клетки (ТЗ 5.8). */
  async findOne(groupId: string, weekId: string): Promise<JournalWeekDto> {
    await this.requireGroup(groupId);
    const week = await this.requireWeek(groupId, weekId);

    return this.compose(week);
  }

  /**
   * Новая неделя (ТЗ 5.8: «NEW WEEK»). Номер назначается системой; итоги
   * действующего состава заводятся сразу нулевыми, чтобы «студент недели
   * с нулём» и «студента в неделе нет» с самого начала были разными вещами.
   */
  async create(groupId: string, dto: CreateJournalWeekDto): Promise<JournalWeekDto> {
    const group = await this.requireGroup(groupId);

    const startDate = parseIsoDate(dto.startDate, 'startDate');
    const days = this.readDays(dto.days, startDate);

    await this.assertDaysFree(groupId, days);

    const roster = await this.repository.findRoster(groupId);
    const weekNumber = await this.repository.nextWeekNumber(groupId);

    const week = await this.repository.createWeek({
      groupId,
      weekNumber,
      startDate,
      days,
      studentIds: roster
        .filter((row) => row.status === MembershipStatus.ACTIVE)
        .map((row) => row.studentId),
    });

    this.logger.log(
      `В журнале группы ${group.name} заведена неделя ${String(weekNumber)} ` +
        `(${formatIsoDate(startDate)}, дней: ${String(days.length)})`,
    );

    return this.compose(week, roster);
  }

  /**
   * Правка недели: сроки, набор дней, отметки и ручные слагаемые (ТЗ 5.8).
   *
   * Итоги пересчитываются по **итоговому** состоянию недели и для всех её
   * студентов, а не только для тех, чьи клетки тронуты: убранный день меняет
   * `Sum` каждому, кто в него приходил.
   */
  async update(
    groupId: string,
    weekId: string,
    dto: UpdateJournalWeekDto,
  ): Promise<JournalWeekDto> {
    await this.requireGroup(groupId);
    const week = await this.requireOpenWeek(groupId, weekId);
    const roster = await this.repository.findRoster(groupId);

    const startDate =
      dto.startDate === undefined ? week.startDate : parseIsoDate(dto.startDate, 'startDate');

    const days = dto.days === undefined ? undefined : this.readDays(dto.days, startDate);
    if (days !== undefined) {
      await this.assertDaysFree(groupId, days, weekId);
    } else if (dto.startDate !== undefined) {
      // Сроки проверяются по итоговому состоянию: сдвинув начало недели, можно
      // выкинуть за её границы дни, которые уже лежат в БД.
      this.assertWithinWeek(
        week.days.map((day) => day.date),
        startDate,
      );
    }

    this.assertKnownStudents(dto, week, roster);
    const entries = this.readEntries(dto, week, days);
    const state = buildState(week, roster, { startDate, days, entries, results: dto.results });

    const updated = await this.repository.updateWeek({
      weekId,
      startDate: dto.startDate === undefined ? undefined : startDate,
      days,
      entries,
      results: resultsOf(state),
    });

    this.logger.log(
      `Правка недели ${String(week.weekNumber)} журнала группы ${groupId}: ` +
        `клеток ${String(entries?.length ?? 0)}, итогов ${String(state.manual.size)}`,
    );

    return this.compose(updated, roster);
  }

  /**
   * «Отметить всех присутствующими» (ТЗ 5.8).
   *
   * Заполняются только **неотмеченные** клетки действующего состава: иначе
   * кнопка стирала бы уже проставленные пропуски, а восстановить их было бы
   * неоткуда. Уже отмеченные — включая `ABSENT` — остаются как есть.
   */
  async markAllPresent(
    groupId: string,
    weekId: string,
    dto: MarkAllPresentDto,
  ): Promise<MarkedAllPresentDto> {
    await this.requireGroup(groupId);
    const week = await this.requireOpenWeek(groupId, weekId);
    const roster = await this.repository.findRoster(groupId);

    const days = this.selectDays(week, dto.date);
    const marked = new Set<string>();
    const entries: WeekEntryInput[] = [];

    for (const day of days) {
      const byStudent = new Map(day.entries.map((entry) => [entry.studentId, entry]));

      for (const member of roster) {
        if (member.status !== MembershipStatus.ACTIVE) continue;
        if (byStudent.get(member.studentId)?.attendance != null) continue;

        entries.push({
          date: day.date,
          studentId: member.studentId,
          attendance: AttendanceMark.PRESENT,
        });
        marked.add(`${String(day.date.getTime())}:${member.studentId}`);
      }
    }

    const state = buildState(week, roster, { startDate: week.startDate, entries });

    const updated = await this.repository.updateWeek({
      weekId,
      entries,
      results: resultsOf(state),
    });

    this.logger.log(
      `Неделя ${String(week.weekNumber)} группы ${groupId}: отмечено присутствующими ` +
        `${String(marked.size)} клеток`,
    );

    return { marked: marked.size, week: await this.compose(updated, roster) };
  }

  /**
   * Финализация недели (ТЗ 5.8: «Отправить результат»): блокировка, автоначисление
   * коинов и отчёт Директору — одной транзакцией (ТЗ 7).
   *
   * Коины начисляются по правилу `coinsForWeekSum` из модуля коинов (ТЗ 5.9),
   * а не по копии порогов здесь: две копии разошлись бы на первой же правке.
   */
  async submit(groupId: string, weekId: string, accountId: string): Promise<WeekSubmittedDto> {
    const group = await this.requireGroup(groupId);
    const week = await this.requireWeek(groupId, weekId);

    if (week.submittedAt !== null) {
      throw new ConflictException(
        `Неделя ${String(week.weekNumber)} уже финализирована — её итоги больше не меняются`,
      );
    }
    if (week.days.length === 0) {
      throw new BusinessRuleException('В неделе нет учебных дней: финализировать нечего', {
        weekNumber: week.weekNumber,
      });
    }

    const roster = await this.repository.findRoster(groupId);
    const state = buildState(week, roster, { startDate: week.startDate });
    const results = resultsOf(state);

    const names = new Map(roster.map((row) => [row.studentId, fullName(row.student)]));
    const awards: WeekCoinAward[] = [];
    const reported: WeekCoinAwardDto[] = [];

    for (const result of results) {
      const coins = coinsForWeekSum(result.sum);
      if (coins === 0) continue;

      awards.push({
        studentId: result.studentId,
        amount: coins,
        reason: `Итог недели ${String(week.weekNumber)}: ${String(result.sum)} баллов`,
      });
      reported.push({
        studentId: result.studentId,
        fullName: names.get(result.studentId) ?? '',
        sum: result.sum,
        coins,
      });
    }

    const author = await this.repository.findEmployeeByAccount(accountId);
    const submitted = await this.repository.submitWeek({
      weekId,
      submittedById: author?.id ?? null,
      submittedAt: new Date(),
      results,
      awards,
    });

    const composed = await this.compose(submitted, roster);
    const coinsAwarded = awards.reduce((total, award) => total + award.amount, 0);

    // Отчёт Директору собирается здесь и уходит в лог; доставка (Telegram/почта)
    // появится с уведомлениями Фазы 11 — обещать её сейчас было бы неправдой.
    this.logger.log(
      `Финализирована неделя ${String(week.weekNumber)} группы ${group.name}: ` +
        `студентов ${String(composed.studentsCount)}, средний балл ` +
        `${composed.averageSum === null ? '—' : String(composed.averageSum)}, ` +
        `начислено коинов ${String(coinsAwarded)}`,
    );

    return {
      week: composed,
      report: {
        groupId,
        groupName: group.name,
        weekNumber: week.weekNumber,
        startDate: formatIsoDate(week.startDate),
        studentsCount: composed.studentsCount,
        averageSum: composed.averageSum,
        coinsAwarded,
        awards: reported,
      },
    };
  }

  /**
   * Удаление недели — для заведённой по ошибке. Маршрута нет в перечне ТЗ 5.8,
   * но без него лишняя неделя навсегда искажала бы средний балл студента,
   * который считается как среднее `Sum` по всем неделям.
   *
   * Финализированная неделя не удаляется (422): по её итогам уже выданы коины,
   * а отобрать их нечем — списание запрещено (ТЗ 5.9).
   */
  async remove(groupId: string, weekId: string): Promise<JournalWeekDeletedDto> {
    await this.requireGroup(groupId);
    const week = await this.requireWeek(groupId, weekId);

    if (week.submittedAt !== null) {
      throw new BusinessRuleException(
        'Финализированная неделя не удаляется: по её итогам уже начислены коины',
        { weekNumber: week.weekNumber },
      );
    }

    await this.repository.deleteWeek(weekId);
    this.logger.log(`Удалена неделя ${String(week.weekNumber)} журнала группы ${groupId}`);

    return { id: weekId, groupId, weekNumber: week.weekNumber };
  }

  // ──────────────────────────────── Сборка ──────────────────────────────────

  /**
   * Собирает неделю для ответа. Строки — это состав группы плюс те, чьи отметки
   * остались в неделе после выхода из состава: журнал не переписывается задним
   * числом, и вычеркнуть человека из уже прошедшей недели нельзя.
   */
  private async compose(week: WeekDetailRow, known?: RosterRow[]): Promise<JournalWeekDto> {
    const roster = known ?? (await this.repository.findRoster(week.groupId));
    const inRoster = new Set(roster.map((row) => row.studentId));

    const outsiders = studentsWithData(week).filter((id) => !inRoster.has(id));
    const profiles = await this.repository.findStudents(outsiders);

    return buildWeekDto(week, roster, profiles);
  }

  // ──────────────────────────────── Правила ─────────────────────────────────

  private async requireGroup(groupId: string): Promise<JournalGroup> {
    const group = await this.repository.findGroup(groupId);
    if (!group) {
      throw new NotFoundException('Группа не найдена');
    }

    return group;
  }

  /**
   * Неделя вместе с группой из пути. Группа проверяется отдельным запросом,
   * чтобы отличить «нет такой группы» от «у группы нет такой недели»: без этого
   * опечатка в идентификаторе группы выглядела бы как пропавшая неделя.
   */
  private async requireWeek(groupId: string, weekId: string): Promise<WeekDetailRow> {
    const week = await this.repository.findWeek(groupId, weekId);
    if (!week) {
      throw new NotFoundException('Неделя не найдена в журнале этой группы');
    }

    return week;
  }

  private async requireOpenWeek(groupId: string, weekId: string): Promise<WeekDetailRow> {
    const week = await this.requireWeek(groupId, weekId);

    if (week.submittedAt !== null) {
      throw new BusinessRuleException(
        `Неделя ${String(week.weekNumber)} финализирована: её отметки больше не правятся`,
        { weekNumber: week.weekNumber, submittedAt: week.submittedAt.toISOString() },
      );
    }

    return week;
  }

  /** Разбор и проверка набора учебных дней: даты не повторяются и лежат внутри недели. */
  private readDays(days: JournalDayInputDto[], startDate: Date): WeekDayInput[] {
    const parsed = days.map((day) => ({
      date: parseIsoDate(day.date, 'days.date'),
      type: day.type ?? DayType.LECTURE,
    }));

    const seen = new Set<number>();
    for (const day of parsed) {
      if (seen.has(day.date.getTime())) {
        throw new BadRequestException({
          message: 'Учебные дни недели повторяются',
          details: { days: formatIsoDate(day.date) },
        });
      }
      seen.add(day.date.getTime());
    }

    this.assertWithinWeek(
      parsed.map((day) => day.date),
      startDate,
    );

    return parsed;
  }

  /**
   * Дни обязаны укладываться в семь суток от начала недели. Без этого правила
   * «неделя» перестала бы означать что-либо: в неё поместился бы месяц занятий,
   * а `Sum` считался бы по произвольному отрезку и не сравнивался бы с другими
   * неделями — при том, что общий балл студента это среднее по ним (ТЗ 5.8).
   */
  private assertWithinWeek(dates: Date[], startDate: Date): void {
    const last = startDate.getTime() + (DAYS_IN_WEEK - 1) * DAY_MS;

    for (const date of dates) {
      if (date.getTime() < startDate.getTime() || date.getTime() > last) {
        throw new BadRequestException({
          message: 'Учебный день не попадает в неделю',
          details: {
            date: formatIsoDate(date),
            week: `${formatIsoDate(startDate)}…${formatIsoDate(new Date(last))}`,
          },
        });
      }
    }
  }

  /** Один календарный день не принадлежит двум неделям группы — иначе приход посчитался бы дважды. */
  private async assertDaysFree(
    groupId: string,
    days: WeekDayInput[],
    exceptWeekId?: string,
  ): Promise<void> {
    const taken = await this.repository.findConflictingDays(
      groupId,
      days.map((day) => day.date),
      exceptWeekId,
    );

    if (taken.length > 0) {
      throw new ConflictException(
        `Эти дни уже входят в другие недели журнала: ${taken
          .map((day) => `${formatIsoDate(day.date)} (неделя ${String(day.week.weekNumber)})`)
          .join(', ')}`,
      );
    }
  }

  /** Разбор клеток из запроса: у каждой должен быть учебный день итоговой недели. */
  private readEntries(
    dto: UpdateJournalWeekDto,
    week: WeekDetailRow,
    days: WeekDayInput[] | undefined,
  ): WeekEntryInput[] | undefined {
    if (dto.entries === undefined) return undefined;

    const available = new Set(
      (days ?? week.days.map((day) => ({ date: day.date }))).map((day) => day.date.getTime()),
    );

    const parsed: WeekEntryInput[] = dto.entries.map((entry) => ({
      date: parseIsoDate(entry.date, 'entries.date'),
      studentId: entry.studentId,
      ...(entry.attendance === undefined ? {} : { attendance: entry.attendance }),
      ...(entry.score === undefined ? {} : { score: entry.score }),
    }));

    const unknown = parsed.filter((entry) => !available.has(entry.date.getTime()));
    if (unknown.length > 0) {
      throw new BusinessRuleException('Отметки поставлены на дни, которых нет в неделе', {
        dates: [...new Set(unknown.map((entry) => formatIsoDate(entry.date)))],
      });
    }

    const seen = new Set<string>();
    for (const entry of parsed) {
      const key = `${String(entry.date.getTime())}:${entry.studentId}`;
      if (seen.has(key)) {
        throw new BadRequestException({
          message: 'Одна и та же клетка журнала передана дважды',
          details: { studentId: entry.studentId, date: formatIsoDate(entry.date) },
        });
      }
      seen.add(key);
    }

    return parsed;
  }

  /**
   * Отмечать можно тех, кто состоит или состоял в группе, и тех, чьи отметки
   * в неделе уже есть. 422, а не 404: ресурс из пути найден, не найдено то,
   * что пришло в теле — то же правило, что при назначении ролей (сессия 0006).
   */
  private assertKnownStudents(
    dto: UpdateJournalWeekDto,
    week: WeekDetailRow,
    roster: RosterRow[],
  ): void {
    const known = new Set([...roster.map((row) => row.studentId), ...studentsWithData(week)]);

    const named = [
      ...(dto.entries ?? []).map((entry) => entry.studentId),
      ...(dto.results ?? []).map((result) => result.studentId),
    ];
    const missing = [...new Set(named)].filter((id) => !known.has(id));

    if (missing.length > 0) {
      throw new BusinessRuleException('Студенты не состоят в этой группе', { studentIds: missing });
    }

    const seen = new Set<string>();
    for (const result of dto.results ?? []) {
      if (seen.has(result.studentId)) {
        throw new BadRequestException({
          message: 'Итог одного студента передан дважды',
          details: { studentId: result.studentId },
        });
      }
      seen.add(result.studentId);
    }
  }

  /** Дни, к которым применяется «отметить всех присутствующими». */
  private selectDays(week: WeekDetailRow, date?: string): WeekDetailRow['days'] {
    if (date === undefined) return week.days;

    const wanted = parseIsoDate(date, 'date');
    const day = week.days.find((item) => item.date.getTime() === wanted.getTime());
    if (day === undefined) {
      throw new BusinessRuleException('В неделе нет такого учебного дня', { date });
    }

    return [day];
  }
}

// ─────────────────────────── Итоговое состояние недели ────────────────────────

/**
 * Собирает состояние недели после применения правки — в памяти, до записи.
 *
 * Так `Sum` считается по тому же снимку, который уходит в БД одной транзакцией,
 * и правило начисления остаётся в сервисе, а не переезжает в слой данных.
 */
function buildState(
  week: WeekDetailRow,
  roster: RosterRow[],
  patch: {
    startDate: Date;
    days?: WeekDayInput[];
    entries?: WeekEntryInput[];
    results?: { studentId: string; bonus?: number; exam?: number }[];
  },
): WeekState {
  const dayTypes = new Map<number, LessonType>(
    (patch.days ?? week.days).map((day) => [day.date.getTime(), day.type]),
  );

  const cells = new Map<string, Map<number, Cell>>();
  const cellOf = (studentId: string): Map<number, Cell> => {
    const existing = cells.get(studentId);
    if (existing !== undefined) return existing;

    const created = new Map<number, Cell>();
    cells.set(studentId, created);

    return created;
  };

  for (const day of week.days) {
    // Клетки убранных дней в подсчёт не идут — их дня в неделе больше нет.
    if (!dayTypes.has(day.date.getTime())) continue;

    for (const entry of day.entries) {
      cellOf(entry.studentId).set(day.date.getTime(), {
        attendance: entry.attendance,
        score: entry.score,
      });
    }
  }

  for (const entry of patch.entries ?? []) {
    const day = cellOf(entry.studentId);
    const current = day.get(entry.date.getTime()) ?? { attendance: null, score: null };

    day.set(entry.date.getTime(), {
      attendance: entry.attendance === undefined ? current.attendance : entry.attendance,
      score: entry.score === undefined ? current.score : entry.score,
    });
  }

  const manual = new Map<string, ManualScore>();

  // Итоги считаются действующему составу и всем, у кого в неделе уже есть данные:
  // ушедший из группы студент своей истории не теряет, а зачисленный на этой
  // неделе попадает в неё с первой же правки.
  for (const member of roster) {
    if (member.status === MembershipStatus.ACTIVE)
      manual.set(member.studentId, { bonus: 0, exam: 0 });
  }
  for (const result of week.results) {
    manual.set(result.studentId, { bonus: result.bonus, exam: result.exam });
  }
  for (const studentId of cells.keys()) {
    if (!manual.has(studentId)) manual.set(studentId, { bonus: 0, exam: 0 });
  }

  for (const result of patch.results ?? []) {
    const current = manual.get(result.studentId) ?? { bonus: 0, exam: 0 };
    manual.set(result.studentId, {
      bonus: result.bonus ?? current.bonus,
      exam: result.exam ?? current.exam,
    });
  }

  return { dayTypes, cells, manual };
}

/** Итоги для записи: `sum` считается по состоянию недели тем же правилом, что и на экране. */
function resultsOf(state: WeekState): WeekResultInput[] {
  const days = [...state.dayTypes].map(([time, type]) => ({ id: String(time), type }));

  return [...state.manual].map(([studentId, manual]) => {
    const cells = state.cells.get(studentId) ?? new Map<number, Cell>();
    const score = computeWeekScore(
      days,
      [...cells].map(([time, cell]) => ({
        dayId: String(time),
        attendance: cell.attendance,
        score: cell.score,
      })),
      manual,
    );

    return { studentId, bonus: manual.bonus, exam: manual.exam, sum: score.sum };
  });
}

// ────────────────────────────── Ответы наружу ─────────────────────────────────

/** Все, чьи данные лежат в неделе, — независимо от того, в составе они сейчас или нет. */
const studentsWithData = (week: WeekDetailRow): string[] => [
  ...new Set([
    ...week.days.flatMap((day) => day.entries.map((entry) => entry.studentId)),
    ...week.results.map((result) => result.studentId),
  ]),
];

const fullName = (person: { firstName: string; lastName: string }): string =>
  `${person.lastName} ${person.firstName}`;

const endDateOf = (week: WeekDetailRow | WeekSummaryRow): string | null => {
  const last = week.days.at(-1);

  return last === undefined ? null : formatIsoDate(last.date);
};

const toSummaryDto = (
  row: WeekSummaryRow,
  aggregate: WeekAggregate | undefined,
): JournalWeekSummaryDto => ({
  id: row.id,
  groupId: row.groupId,
  weekNumber: row.weekNumber,
  startDate: formatIsoDate(row.startDate),
  endDate: endDateOf(row),
  days: row.days.map((day) => ({ id: day.id, date: formatIsoDate(day.date), type: day.type })),
  submitted: row.submittedAt !== null,
  submittedAt: row.submittedAt === null ? null : row.submittedAt.toISOString(),
  submittedBy: row.submittedBy,
  studentsCount: aggregate?.studentsCount ?? 0,
  averageSum: roundAverage(aggregate?.averageSum ?? null),
});

/** Неделя целиком со строками студентов. */
function buildWeekDto(
  week: WeekDetailRow,
  roster: RosterRow[],
  outsiders: StudentProfile[],
): JournalWeekDto {
  const days = week.days;
  const manual = new Map(week.results.map((result) => [result.studentId, result]));

  const people: { profile: StudentProfile; membershipStatus: GroupStudentStatus | null }[] = [
    ...roster.map((row) => ({ profile: row.student, membershipStatus: row.status })),
    ...outsiders
      .slice()
      .sort((a, b) => fullName(a).localeCompare(fullName(b), 'ru'))
      .map((profile) => ({ profile, membershipStatus: null })),
  ];

  const scoredDays = days.map((day) => ({ id: day.id, type: day.type }));

  const rows: JournalRowDto[] = people.map(({ profile, membershipStatus }) => {
    const cells = days.map((day) => {
      const entry = day.entries.find((item) => item.studentId === profile.id);

      return {
        dayId: day.id,
        date: formatIsoDate(day.date),
        attendance: entry?.attendance ?? null,
        score: entry?.score ?? null,
      };
    });

    const extra = manual.get(profile.id);
    const score = computeWeekScore(scoredDays, cells, {
      bonus: extra?.bonus ?? 0,
      exam: extra?.exam ?? 0,
    });

    return {
      student: profile,
      membershipStatus,
      entries: cells,
      attendanceScore: score.attendance,
      homeworkScore: score.homework,
      exam: score.exam,
      bonus: score.bonus,
      sum: score.sum,
    };
  });

  // Средний балл считается по тем, у кого есть итог за неделю: студент, который
  // в неделе не участвовал, не должен тянуть среднее вниз нулём.
  const scored = rows.filter((row) => manual.has(row.student.id));
  const averageSum =
    scored.length === 0
      ? null
      : roundAverage(scored.reduce((total, row) => total + row.sum, 0) / scored.length);

  return {
    id: week.id,
    groupId: week.groupId,
    weekNumber: week.weekNumber,
    startDate: formatIsoDate(week.startDate),
    endDate: endDateOf(week),
    days: days.map((day) => ({ id: day.id, date: formatIsoDate(day.date), type: day.type })),
    submitted: week.submittedAt !== null,
    submittedAt: week.submittedAt === null ? null : week.submittedAt.toISOString(),
    submittedBy: week.submittedBy,
    studentsCount: scored.length,
    averageSum,
    rows,
  };
}

/** Средний балл округляется до сотых: в JSON он число, а не бесконечная дробь. */
const roundAverage = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 100) / 100;
