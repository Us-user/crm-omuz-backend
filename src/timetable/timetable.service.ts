import { Injectable } from '@nestjs/common';

import { formatDayTime, formatIsoDate, parseIsoDate } from '../common';
import type { TimetableDayDto, TimetableDto, TimetableLessonDto, TimetableQueryDto } from './dto';
import type { TimetableDayFacts, TimetableJournalFact, TimetableSlotFact } from './timetable';
import {
  countLessons,
  DAYS_IN_WEEK,
  dateSequence,
  expandTimetable,
  resolveTimetableWindow,
  weekDaysOf,
} from './timetable';
import type { TimetableJournalRow, TimetableSlotRow } from './timetable.repository';
import { TimetableRepository } from './timetable.repository';

/**
 * Общее расписание центра (ТЗ 5.10).
 *
 * Витрина поверх слотов групп: своей модели у неё нет. Слот повторяется
 * еженедельно в пределах сроков группы (решение сессии 0011) — календарь
 * Day/Week/Month разворачивает его в даты выбранного окна, и это единственное,
 * чего до сих пор в проекте не делал никто.
 *
 * Календарь **только читает**: занятия ставятся и правятся расписанием группы
 * (`/groups/{id}/schedule`), где живут правила про аудиторию из филиала группы,
 * ментора из состава менторов и пересечения. Второй способ поставить занятие
 * был бы вторым источником истины о том же — то же решение, что у витрины
 * покинувших курсы (0025), где нет отчисления, и у выпускников (0026),
 * где нет `POST`.
 *
 * Что календарь показывает и чего не показывает:
 *
 *   - **`Type`** (колонка ТЗ 5.10) берётся из **журнала**: у слота типа нет
 *     и быть не может — при еженедельном повторении каждый понедельник это
 *     другой день программы (0011). У дня журнала тип есть и относится
 *     к конкретной дате, поэтому он же отвечает на вопрос «занятие проведено
 *     или только запланировано» (`held`);
 *   - **ментор** остаётся плановым — тем, кто проставлен на слоте (ТЗ 5.10:
 *     «источник — слоты групп + ментор + комната»). Фактический ведущий дня
 *     журнала (`JournalDay.mentorId`, сессия 0032) сюда не подставляется:
 *     две колонки «кто ведёт» в одной ячейке читались бы как ошибка данных,
 *     а часы по факту считает зарплатная ведомость, а не календарь;
 *   - **дни журнала без слота в календарь не попадают.** Журнал разрешает
 *     завести день, которого нет в расписании (0018: слот — план, журнал —
 *     факт), но источником календаря ТЗ 5.10 называет именно слоты, и показывать
 *     занятие там, где его не планировали, значило бы смешать два ответа.
 */
@Injectable()
export class TimetableService {
  constructor(private readonly repository: TimetableRepository) {}

  /** Календарь занятий всех групп за окно (ТЗ 5.10). */
  async find(query: TimetableQueryDto): Promise<TimetableDto> {
    const anchor = query.date === undefined ? new Date() : parseIsoDate(query.date, 'date');
    const window = resolveTimetableWindow(query.view, anchor);
    const dates = dateSequence(window.from, window.to);
    const weekDays = weekDaysOf(dates);

    const slots = await this.repository.findSlots({
      from: window.from,
      to: window.to,
      // Условие ставится только там, где оно сужает: у месяца в окне все семь
      // дней недели, и `in` из семи значений был бы обрядом, а не фильтром.
      weekDays: weekDays.length < DAYS_IN_WEEK ? weekDays : undefined,
      groupId: query.groupId,
      courseId: query.courseId,
      branchId: query.branchId,
      roomId: query.roomId,
      mentorId: query.mentorId,
      format: query.format,
    });

    const groupIds = [...new Set(slots.map((slot) => slot.group.id))];

    // Пустое окно журнал не спрашивает: запрос вернул бы пустоту за деньги
    // (правило сессий 0019 и 0023 про лишние запросы).
    const journal =
      groupIds.length === 0
        ? []
        : await this.repository.findJournalDays({ from: window.from, to: window.to, groupIds });

    const days = expandTimetable(dates, slots.map(toSlotFact), journal.map(toJournalFact));

    return {
      view: query.view,
      from: formatIsoDate(window.from),
      to: formatIsoDate(window.to),
      total: countLessons(days),
      days: days.map(toDayDto),
    };
  }
}

const toSlotFact = (row: TimetableSlotRow): TimetableSlotFact => ({
  slotId: row.id,
  dayOfWeek: row.dayOfWeek,
  startMinute: row.startMinute,
  endMinute: row.endMinute,
  group: {
    id: row.group.id,
    name: row.group.name,
    format: row.group.format,
    status: row.group.status,
    startDate: row.group.startDate,
    endDate: row.group.endDate,
  },
  course: { id: row.group.course.id, name: row.group.course.title },
  branch: row.group.branch,
  room: row.room,
  mentor: row.mentor,
});

const toJournalFact = (row: TimetableJournalRow): TimetableJournalFact => ({
  groupId: row.week.groupId,
  date: row.date,
  type: row.type,
});

/**
 * Минуты от полуночи переводятся в `HH:MM` здесь, а не в чистой функции:
 * разворот считает и сравнивает время числами (приём сессии 0011), а `HH:MM` —
 * дело показа, как `roundScore` у общего балла (0019).
 */
const toDayDto = (day: TimetableDayFacts): TimetableDayDto => ({
  date: day.date,
  weekDay: day.weekDay,
  lessons: day.lessons.map((lesson): TimetableLessonDto => ({
    slotId: lesson.slotId,
    date: lesson.date,
    weekDay: lesson.weekDay,
    startTime: formatDayTime(lesson.startMinute),
    endTime: formatDayTime(lesson.endMinute),
    group: lesson.group,
    course: lesson.course,
    branch: lesson.branch,
    room: lesson.room,
    mentor: lesson.mentor,
    type: lesson.type,
    held: lesson.held,
  })),
});
