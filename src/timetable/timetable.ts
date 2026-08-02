import type { GroupFormat, GroupStatus, LessonType } from '@prisma/client';
import { WeekDay } from '@prisma/client';

import { formatIsoDate } from '../common';

/**
 * Общее расписание центра (ТЗ 5.10) — чистые функции разворота.
 *
 * Своей модели у календаря нет: занятие — это слот группы (`ScheduleSlot`),
 * который **повторяется еженедельно** в пределах сроков группы (решение сессии
 * 0011). Календарь Day/Week/Month из ТЗ 5.10 — это тот же слот, развёрнутый
 * в конкретные даты выбранного окна, и разворот и есть единственное новое
 * умение фазы.
 *
 * Разворот считается в памяти, а не запросом: «дата, у которой день недели
 * совпадает с днём слота» в Prisma не выражается (нужен `date_trunc`/`extract`,
 * то есть сырой SQL, которого в проекте нет), а окно ограничено месяцем
 * по построению — набор не может вырасти до «всей истории центра» случайно.
 * Тот же ход, что с помесячной раскладкой оттока (0025) и обзора (0030).
 */

/** Вид окна календаря (ТЗ 5.10: Day/Week/Month). */
export enum TimetableView {
  Day = 'day',
  Week = 'week',
  Month = 'month',
}

/** Именованная ссылка: курс, филиал, аудитория. */
export interface NamedRef {
  id: string;
  name: string;
}

/** Ментор в ячейке календаря (ТЗ 5.10 показывает его рядом с аудиторией). */
export interface TimetableMentor {
  id: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
}

/** Группа в том виде, в каком её проверяет правило «идут ли занятия в этот день». */
export interface TimetableGroup {
  id: string;
  name: string;
  format: GroupFormat;
  status: GroupStatus;
  /** Незаполненная граница — открытая: сроки группы могли ещё не назвать. */
  startDate: Date | null;
  endDate: Date | null;
}

/** Слот, попавший в окно, вместе со всем, что рисует ячейка календаря. */
export interface TimetableSlotFact {
  slotId: string;
  dayOfWeek: WeekDay;
  startMinute: number;
  endMinute: number;
  group: TimetableGroup;
  course: NamedRef;
  branch: NamedRef;
  room: NamedRef | null;
  mentor: TimetableMentor | null;
}

/**
 * Учебный день журнала — **факт** проведённого занятия (ТЗ 5.8).
 *
 * Отсюда календарь берёт `Type`: у слота его нет и быть не может (решение
 * сессии 0011 — при еженедельном повторении каждый понедельник это другой день
 * программы), а у дня журнала тип есть и относится к конкретной дате.
 */
export interface TimetableJournalFact {
  groupId: string;
  date: Date;
  type: LessonType;
}

/** Одно занятие в конкретной дате — развёрнутый слот. */
export interface TimetableLesson {
  slotId: string;
  date: string;
  weekDay: WeekDay;
  startMinute: number;
  endMinute: number;
  group: { id: string; name: string; format: GroupFormat; status: GroupStatus };
  course: NamedRef;
  branch: NamedRef;
  room: NamedRef | null;
  mentor: TimetableMentor | null;
  /** Тип из журнала. `null` — дня журнала на эту дату нет (обычно будущее). */
  type: LessonType | null;
  /** Заведён ли день журнала: занятие проведено, а не только запланировано. */
  held: boolean;
}

/** Столбец календаря: дата и её занятия. Пустые дни из ряда не пропадают. */
export interface TimetableDayFacts {
  date: string;
  weekDay: WeekDay;
  lessons: TimetableLesson[];
}

/**
 * Порядок дней недели в `WeekDay` начинается с понедельника, а `Date.getUTCDay()`
 * — с воскресенья. Таблица переводит одно в другое, не полагаясь на арифметику
 * по модулю: она читается глазами и не ломается при добавлении значения.
 */
const WEEK_DAYS: readonly WeekDay[] = [
  WeekDay.SUNDAY,
  WeekDay.MONDAY,
  WeekDay.TUESDAY,
  WeekDay.WEDNESDAY,
  WeekDay.THURSDAY,
  WeekDay.FRIDAY,
  WeekDay.SATURDAY,
];

/** День недели даты (UTC) в терминах `WeekDay`. */
export const weekDayOf = (date: Date): WeekDay => WEEK_DAYS[date.getUTCDay()];

/** Полночь UTC того же дня: время в календаре живёт в слоте, а не в дате. */
export const dayStartOf = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/**
 * Понедельник недели, содержащей дату.
 *
 * Неделя начинается с понедельника — тем же порядком, каким объявлен `WeekDay`
 * (сессия 0011: «порядок объявления в PostgreSQL и есть порядок сортировки»).
 * Второе понятие начала недели рядом с первым разошлось бы с ним.
 */
export const weekStartOf = (date: Date): Date => {
  const start = dayStartOf(date);
  // getUTCDay(): 0 — воскресенье. Сдвиг до понедельника: воскресенье уходит
  // на шесть дней назад, остальные — на (день − 1).
  const shift = (start.getUTCDay() + 6) % 7;

  return new Date(start.getTime() - shift * DAY_MS);
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Окно календаря для выбранного вида (ТЗ 5.10), обе границы включительно.
 *
 * Окно ограничено по построению: день — одна дата, неделя — семь, месяц —
 * не больше тридцати одной. Отдельного потолка поэтому нет: «выгрузить всё»
 * из этого запроса не получается в принципе.
 */
export function resolveTimetableWindow(
  view: TimetableView,
  anchor: Date,
): {
  from: Date;
  to: Date;
} {
  const day = dayStartOf(anchor);

  if (view === TimetableView.Day) return { from: day, to: day };

  if (view === TimetableView.Week) {
    const from = weekStartOf(day);

    return { from, to: new Date(from.getTime() + 6 * DAY_MS) };
  }

  const year = day.getUTCFullYear();
  const month = day.getUTCMonth();

  // Нулевой день следующего месяца — последний день текущего: сколько в нём
  // дней (28/29/30/31), выводить самому не приходится (приём `nextIsoMonth`, 0021).
  return {
    from: new Date(Date.UTC(year, month, 1)),
    to: new Date(Date.UTC(year, month + 1, 0)),
  };
}

/**
 * Все даты отрезка `[from, to]` включительно.
 *
 * Дни без занятий остаются в ряду пустыми — это и есть смысл функции. Календарь,
 * в котором пустой день просто отсутствует, читается как «данных нет», а
 * расстояние между колонками перестаёт быть временем (тот же довод, что
 * у `monthSequence` для помесячного графика, 0025).
 */
export function dateSequence(from: Date, to: Date): Date[] {
  const dates: Date[] = [];

  for (let date = dayStartOf(from); date.getTime() <= to.getTime();) {
    dates.push(date);
    date = new Date(date.getTime() + DAY_MS);
  }

  return dates;
}

/** Дней в неделе. Окно этой длины и длиннее покрывает все дни недели. */
export const DAYS_IN_WEEK = 7;

/** Дни недели, встречающиеся в окне: у окна короче недели их меньше семи. */
export const weekDaysOf = (dates: readonly Date[]): WeekDay[] => [...new Set(dates.map(weekDayOf))];

/**
 * Идут ли у группы занятия в эту дату.
 *
 * Два правила, и оба нужны:
 *
 *   - **дата внутри сроков группы.** Слот повторяется еженедельно (0011),
 *     то есть сам по себе бесконечен; без сроков группа, отучившаяся в марте,
 *     показывала бы занятия в декабре. Незаполненная граница считается
 *     открытой — тот же выбор, что при проверке пересечений расписания (0011):
 *     цена ложного показа ниже, чем цена молча пропавшего занятия;
 *   - **группа не отменена.** `CANCELLED` означает, что набор не состоялся
 *     и обучения не было вообще (0008), поэтому её занятий нет ни в будущем,
 *     ни в прошлом. `FINISHED` при этом из календаря не убирается: её занятия
 *     были, и прошлый месяц обязан их показать — ограничивают их сроки группы.
 *
 * Правило живёт здесь, а не в `where` запроса: «дата попадает в сроки» проверяется
 * для каждой даты окна отдельно, а запрос отбирает лишь кандидатов — группы,
 * чьи сроки пересекают окно целиком. Repository сужает, решает сервис (приём 0011).
 */
export const runsOn = (group: TimetableGroup, date: Date): boolean => {
  if (group.status === 'CANCELLED') return false;
  if (group.startDate !== null && group.startDate.getTime() > date.getTime()) return false;
  if (group.endDate !== null && group.endDate.getTime() < date.getTime()) return false;

  return true;
};

/**
 * Разворачивает еженедельные слоты в занятия конкретных дат окна (ТЗ 5.10)
 * и подмешивает тип из журнала.
 *
 * Внутри дня порядок — по времени начала, при совпадении по названию группы
 * и затем по идентификатору слота: две группы, начинающие в 10:00, должны
 * приходить в одном и том же порядке от запроса к запросу (приём устойчивого
 * порядка из 0024).
 */
export function expandTimetable(
  dates: readonly Date[],
  slots: readonly TimetableSlotFact[],
  journal: readonly TimetableJournalFact[],
): TimetableDayFacts[] {
  const held = new Map(journal.map((day) => [factKey(day.groupId, day.date), day.type]));

  return dates.map((date) => {
    const weekDay = weekDayOf(date);
    const iso = formatIsoDate(date);

    const lessons = slots
      .filter((slot) => slot.dayOfWeek === weekDay && runsOn(slot.group, date))
      .map((slot): TimetableLesson => {
        const type = held.get(factKey(slot.group.id, date));

        return {
          slotId: slot.slotId,
          date: iso,
          weekDay,
          startMinute: slot.startMinute,
          endMinute: slot.endMinute,
          group: {
            id: slot.group.id,
            name: slot.group.name,
            format: slot.group.format,
            status: slot.group.status,
          },
          course: slot.course,
          branch: slot.branch,
          room: slot.room,
          mentor: slot.mentor,
          type: type ?? null,
          held: type !== undefined,
        };
      })
      .sort(
        (a, b) =>
          a.startMinute - b.startMinute ||
          compareText(a.group.name, b.group.name) ||
          compareText(a.slotId, b.slotId),
      );

    return { date: iso, weekDay, lessons };
  });
}

/** Сколько занятий в окне — итог поверх уже развёрнутых дней, а не второй проход. */
export const countLessons = (days: readonly TimetableDayFacts[]): number =>
  days.reduce((total, day) => total + day.lessons.length, 0);

/** Ключ «группа + день»: у группы не бывает двух дней журнала на одну дату. */
const factKey = (groupId: string, date: Date): string => `${groupId}|${formatIsoDate(date)}`;

/**
 * Сравнение без учёта локали: `localeCompare` зависит от окружения, а порядок
 * занятий внутри дня должен быть одним и тем же везде (тот же довод, что в 0025).
 */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
