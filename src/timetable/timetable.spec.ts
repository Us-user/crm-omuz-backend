import { GroupFormat, GroupStatus, LessonType, WeekDay } from '@prisma/client';

import type { TimetableGroup, TimetableJournalFact, TimetableSlotFact } from './timetable';
import {
  countLessons,
  dateSequence,
  dayStartOf,
  expandTimetable,
  resolveTimetableWindow,
  runsOn,
  TimetableView,
  weekDayOf,
  weekDaysOf,
  weekStartOf,
} from './timetable';

const utc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const iso = (date: Date): string => date.toISOString().slice(0, 10);

const group = (overrides: Partial<TimetableGroup> = {}): TimetableGroup => ({
  id: 'group-1',
  name: 'Frontend-1',
  format: GroupFormat.OFFLINE,
  status: GroupStatus.ACTIVE,
  startDate: null,
  endDate: null,
  ...overrides,
});

const slot = (overrides: Partial<TimetableSlotFact> = {}): TimetableSlotFact => ({
  slotId: 'slot-1',
  dayOfWeek: WeekDay.MONDAY,
  startMinute: 600,
  endMinute: 720,
  group: group(),
  course: { id: 'course-1', name: 'Frontend' },
  branch: { id: 'branch-1', name: 'Садбарг' },
  room: { id: 'room-1', name: '101' },
  mentor: { id: 'mentor-1', firstName: 'Фаррух', lastName: 'Раҳимов', middleName: null },
  ...overrides,
});

describe('weekDayOf', () => {
  it('переводит день недели из воскресной нумерации Date в WeekDay', () => {
    expect(weekDayOf(utc('2026-09-14'))).toBe(WeekDay.MONDAY);
    expect(weekDayOf(utc('2026-09-15'))).toBe(WeekDay.TUESDAY);
    expect(weekDayOf(utc('2026-09-20'))).toBe(WeekDay.SUNDAY);
  });

  it('не зависит от времени внутри суток', () => {
    expect(weekDayOf(new Date('2026-09-14T23:59:59.000Z'))).toBe(WeekDay.MONDAY);
  });
});

describe('dayStartOf', () => {
  it('срезает время до полуночи UTC', () => {
    expect(dayStartOf(new Date('2026-09-14T18:45:12.000Z')).toISOString()).toBe(
      '2026-09-14T00:00:00.000Z',
    );
  });
});

describe('weekStartOf', () => {
  it('неделя начинается с понедельника', () => {
    expect(iso(weekStartOf(utc('2026-09-16')))).toBe('2026-09-14');
  });

  it('понедельник остаётся собой', () => {
    expect(iso(weekStartOf(utc('2026-09-14')))).toBe('2026-09-14');
  });

  it('воскресенье относится к своей неделе, а не к следующей', () => {
    expect(iso(weekStartOf(utc('2026-09-20')))).toBe('2026-09-14');
    expect(iso(weekStartOf(utc('2026-09-13')))).toBe('2026-09-07');
  });
});

describe('resolveTimetableWindow', () => {
  it('day — одна дата', () => {
    const window = resolveTimetableWindow(TimetableView.Day, utc('2026-09-16'));

    expect([iso(window.from), iso(window.to)]).toEqual(['2026-09-16', '2026-09-16']);
  });

  it('week — с понедельника по воскресенье вокруг даты', () => {
    const window = resolveTimetableWindow(TimetableView.Week, utc('2026-09-16'));

    expect([iso(window.from), iso(window.to)]).toEqual(['2026-09-14', '2026-09-20']);
  });

  it('month — календарный месяц целиком', () => {
    const window = resolveTimetableWindow(TimetableView.Month, utc('2026-09-16'));

    expect([iso(window.from), iso(window.to)]).toEqual(['2026-09-01', '2026-09-30']);
  });

  it('длина месяца выводится, а не задаётся: февраль високосного года', () => {
    const window = resolveTimetableWindow(TimetableView.Month, utc('2028-02-15'));

    expect(iso(window.to)).toBe('2028-02-29');
  });

  it('декабрь не уезжает в следующий год', () => {
    const window = resolveTimetableWindow(TimetableView.Month, utc('2026-12-31'));

    expect([iso(window.from), iso(window.to)]).toEqual(['2026-12-01', '2026-12-31']);
  });

  it('время внутри даты на окно не влияет', () => {
    const window = resolveTimetableWindow(TimetableView.Day, new Date('2026-09-16T21:30:00.000Z'));

    expect(window.from.toISOString()).toBe('2026-09-16T00:00:00.000Z');
  });
});

describe('dateSequence', () => {
  it('отдаёт обе границы включительно', () => {
    const dates = dateSequence(utc('2026-09-14'), utc('2026-09-20')).map(iso);

    expect(dates).toHaveLength(7);
    expect(dates[0]).toBe('2026-09-14');
    expect(dates[6]).toBe('2026-09-20');
  });

  it('окно из одного дня — одна дата', () => {
    expect(dateSequence(utc('2026-09-14'), utc('2026-09-14')).map(iso)).toEqual(['2026-09-14']);
  });

  it('месяц из тридцати одного дня', () => {
    expect(dateSequence(utc('2026-08-01'), utc('2026-08-31'))).toHaveLength(31);
  });

  it('перевёрнутый отрезок даёт пустой ряд, а не бесконечный', () => {
    expect(dateSequence(utc('2026-09-20'), utc('2026-09-14'))).toEqual([]);
  });
});

describe('weekDaysOf', () => {
  it('у окна короче недели дней недели меньше семи', () => {
    const days = weekDaysOf(dateSequence(utc('2026-09-14'), utc('2026-09-16')));

    expect(days).toEqual([WeekDay.MONDAY, WeekDay.TUESDAY, WeekDay.WEDNESDAY]);
  });

  it('месяц покрывает все семь дней и повторов не даёт', () => {
    const days = weekDaysOf(dateSequence(utc('2026-09-01'), utc('2026-09-30')));

    expect(days).toHaveLength(7);
    expect(new Set(days).size).toBe(7);
  });
});

describe('runsOn', () => {
  it('дата внутри сроков — занятия идут', () => {
    const target = group({ startDate: utc('2026-09-01'), endDate: utc('2026-09-30') });

    expect(runsOn(target, utc('2026-09-14'))).toBe(true);
  });

  it('обе границы сроков включающие', () => {
    const target = group({ startDate: utc('2026-09-01'), endDate: utc('2026-09-30') });

    expect(runsOn(target, utc('2026-09-01'))).toBe(true);
    expect(runsOn(target, utc('2026-09-30'))).toBe(true);
  });

  it('до начала и после окончания занятий нет', () => {
    const target = group({ startDate: utc('2026-09-01'), endDate: utc('2026-09-30') });

    expect(runsOn(target, utc('2026-08-31'))).toBe(false);
    expect(runsOn(target, utc('2026-10-01'))).toBe(false);
  });

  it('незаполненная граница считается открытой', () => {
    expect(runsOn(group({ startDate: utc('2026-09-01') }), utc('2030-01-01'))).toBe(true);
    expect(runsOn(group({ endDate: utc('2026-09-30') }), utc('2000-01-01'))).toBe(true);
    expect(runsOn(group(), utc('2026-09-14'))).toBe(true);
  });

  it('отменённая группа занятий не проводит ни в какую дату', () => {
    const cancelled = group({ status: GroupStatus.CANCELLED });

    expect(runsOn(cancelled, utc('2026-09-14'))).toBe(false);
  });

  it('завершённая группа из календаря не убирается — её ограничивают сроки', () => {
    const finished = group({
      status: GroupStatus.FINISHED,
      startDate: utc('2026-09-01'),
      endDate: utc('2026-09-30'),
    });

    expect(runsOn(finished, utc('2026-09-14'))).toBe(true);
    expect(runsOn(finished, utc('2026-10-14'))).toBe(false);
  });
});

describe('expandTimetable', () => {
  const week = dateSequence(utc('2026-09-14'), utc('2026-09-20'));

  it('разворачивает еженедельный слот в свой день недели', () => {
    const days = expandTimetable(week, [slot()], []);

    expect(days).toHaveLength(7);
    expect(days[0]?.date).toBe('2026-09-14');
    expect(days[0]?.lessons).toHaveLength(1);
    expect(days[0]?.lessons[0]?.date).toBe('2026-09-14');
    expect(days.slice(1).every((day) => day.lessons.length === 0)).toBe(true);
  });

  it('дни без занятий остаются в ряду с пустым списком', () => {
    const days = expandTimetable(week, [], []);

    expect(days.map((day) => day.date)).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ]);
    expect(days.every((day) => day.lessons.length === 0)).toBe(true);
  });

  it('слот повторяется в каждой неделе окна', () => {
    const month = dateSequence(utc('2026-09-01'), utc('2026-09-30'));
    const days = expandTimetable(month, [slot()], []);

    // Понедельники сентября 2026: 7, 14, 21, 28.
    expect(countLessons(days)).toBe(4);
  });

  it('за пределами сроков группы занятия не появляются', () => {
    const bounded = slot({
      group: group({ startDate: utc('2026-09-15'), endDate: utc('2026-09-30') }),
    });
    const month = dateSequence(utc('2026-09-01'), utc('2026-09-30'));

    expect(countLessons(expandTimetable(month, [bounded], []))).toBe(2);
  });

  it('отменённая группа в календарь не попадает', () => {
    const cancelled = slot({ group: group({ status: GroupStatus.CANCELLED }) });

    expect(countLessons(expandTimetable(week, [cancelled], []))).toBe(0);
  });

  it('тип занятия и признак «проведено» приходят из журнала', () => {
    const journal: TimetableJournalFact[] = [
      { groupId: 'group-1', date: utc('2026-09-14'), type: LessonType.EXAM },
    ];
    const month = dateSequence(utc('2026-09-01'), utc('2026-09-30'));
    const days = expandTimetable(month, [slot()], journal);

    const held = days.flatMap((day) => day.lessons).filter((lesson) => lesson.held);
    expect(held).toHaveLength(1);
    expect(held[0]?.date).toBe('2026-09-14');
    expect(held[0]?.type).toBe(LessonType.EXAM);
  });

  it('без дня журнала занятие остаётся запланированным', () => {
    const days = expandTimetable(week, [slot()], []);
    const lesson = days[0]?.lessons[0];

    expect(lesson?.type).toBeNull();
    expect(lesson?.held).toBe(false);
  });

  it('день журнала соседней группы чужое занятие не помечает', () => {
    const journal: TimetableJournalFact[] = [
      { groupId: 'group-2', date: utc('2026-09-14'), type: LessonType.PRACTICE },
    ];
    const days = expandTimetable(week, [slot()], journal);

    expect(days[0]?.lessons[0]?.held).toBe(false);
  });

  it('день журнала другой даты занятие не помечает', () => {
    const journal: TimetableJournalFact[] = [
      { groupId: 'group-1', date: utc('2026-09-21'), type: LessonType.PRACTICE },
    ];
    const days = expandTimetable(week, [slot()], journal);

    expect(days[0]?.lessons[0]?.held).toBe(false);
  });

  it('внутри дня занятия идут по времени начала', () => {
    const late = slot({ slotId: 'slot-late', startMinute: 840, endMinute: 960 });
    const early = slot({ slotId: 'slot-early', startMinute: 480, endMinute: 600 });

    const lessons = expandTimetable(week, [late, early], [])[0]?.lessons ?? [];

    expect(lessons.map((lesson) => lesson.slotId)).toEqual(['slot-early', 'slot-late']);
  });

  it('при совпадении времени порядок задаёт название группы, затем слот', () => {
    const b = slot({ slotId: 'slot-b', group: group({ id: 'g-b', name: 'Python-1' }) });
    const a = slot({ slotId: 'slot-a', group: group({ id: 'g-a', name: 'Backend-1' }) });
    const aTwin = slot({ slotId: 'slot-a2', group: group({ id: 'g-a', name: 'Backend-1' }) });

    const lessons = expandTimetable(week, [b, aTwin, a], [])[0]?.lessons ?? [];

    expect(lessons.map((lesson) => lesson.slotId)).toEqual(['slot-a', 'slot-a2', 'slot-b']);
  });

  it('порядок не зависит от порядка входа', () => {
    const one = slot({ slotId: 'slot-1', startMinute: 600 });
    const two = slot({ slotId: 'slot-2', startMinute: 480 });

    const forward = expandTimetable(week, [one, two], [])[0]?.lessons.map((l) => l.slotId);
    const backward = expandTimetable(week, [two, one], [])[0]?.lessons.map((l) => l.slotId);

    expect(forward).toEqual(backward);
  });

  it('минуты наружу не переводятся: перевод в HH:MM — дело показа', () => {
    const lesson = expandTimetable(week, [slot()], [])[0]?.lessons[0];

    expect(lesson?.startMinute).toBe(600);
    expect(lesson?.endMinute).toBe(720);
  });

  it('курс, филиал, аудитория и ментор доезжают до ячейки', () => {
    const lesson = expandTimetable(week, [slot()], [])[0]?.lessons[0];

    expect(lesson?.course).toEqual({ id: 'course-1', name: 'Frontend' });
    expect(lesson?.branch).toEqual({ id: 'branch-1', name: 'Садбарг' });
    expect(lesson?.room).toEqual({ id: 'room-1', name: '101' });
    expect(lesson?.mentor?.id).toBe('mentor-1');
  });

  it('занятие онлайн без аудитории и без ведущего остаётся в календаре', () => {
    const online = slot({
      room: null,
      mentor: null,
      group: group({ format: GroupFormat.ONLINE }),
    });
    const lesson = expandTimetable(week, [online], [])[0]?.lessons[0];

    expect(lesson?.room).toBeNull();
    expect(lesson?.mentor).toBeNull();
    expect(lesson?.group.format).toBe(GroupFormat.ONLINE);
  });

  it('вход не меняется', () => {
    const slots = [slot()];
    const snapshot = JSON.stringify(slots);

    expandTimetable(week, slots, []);

    expect(JSON.stringify(slots)).toBe(snapshot);
  });
});

describe('countLessons', () => {
  it('складывает занятия всех дней', () => {
    const month = dateSequence(utc('2026-09-01'), utc('2026-09-30'));
    const tuesday = slot({ slotId: 'slot-tue', dayOfWeek: WeekDay.TUESDAY });

    // Понедельников в сентябре 2026 четыре, вторников — пять.
    expect(countLessons(expandTimetable(month, [slot(), tuesday], []))).toBe(9);
  });

  it('пустой календарь — ноль', () => {
    expect(countLessons([])).toBe(0);
  });
});
