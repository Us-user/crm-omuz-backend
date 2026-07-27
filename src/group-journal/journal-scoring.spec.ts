import { AttendanceMark, LessonType } from '@prisma/client';

import type { ScoredDay, ScoredEntry } from './journal-scoring';
import { computeWeekScore, isArrival, MAX_HOMEWORK_SCORE } from './journal-scoring';

const lecture: ScoredDay = { id: 'd1', type: LessonType.LECTURE };
const practice: ScoredDay = { id: 'd2', type: LessonType.PRACTICE };
const exam: ScoredDay = { id: 'd3', type: LessonType.EXAM };

const cell = (dayId: string, overrides: Partial<ScoredEntry> = {}): ScoredEntry => ({
  dayId,
  attendance: null,
  score: null,
  ...overrides,
});

describe('computeWeekScore (ТЗ 5.8)', () => {
  it('считает приход за каждый посещённый день', () => {
    const score = computeWeekScore(
      [lecture, practice],
      [
        cell('d1', { attendance: AttendanceMark.PRESENT }),
        cell('d2', { attendance: AttendanceMark.PRESENT }),
      ],
      { bonus: 0, exam: 0 },
    );

    expect(score.attendance).toBe(2);
    expect(score.sum).toBe(2);
  });

  it('опоздание считается приходом', () => {
    // ТЗ 5.8 говорит «приход = 1 балл» и штрафа за опоздание не вводит;
    // `LATE` существует ради графика посещаемости из ТЗ 5.2.
    const score = computeWeekScore([lecture], [cell('d1', { attendance: AttendanceMark.LATE })], {
      bonus: 0,
      exam: 0,
    });

    expect(score.attendance).toBe(1);
  });

  it('пропуск и неотмеченная клетка прихода не дают', () => {
    const absent = computeWeekScore(
      [lecture],
      [cell('d1', { attendance: AttendanceMark.ABSENT })],
      { bonus: 0, exam: 0 },
    );
    const unmarked = computeWeekScore([lecture], [cell('d1')], { bonus: 0, exam: 0 });

    expect(absent.attendance).toBe(0);
    expect(unmarked.attendance).toBe(0);
  });

  it('на экзамене приход не считается', () => {
    // Главное правило подсчёта из ТЗ 5.8: за экзамен балл приходит слагаемым
    // `exam`, и приход в тот же день начислил бы день дважды.
    const score = computeWeekScore([exam], [cell('d3', { attendance: AttendanceMark.PRESENT })], {
      bonus: 0,
      exam: 60,
    });

    expect(score.attendance).toBe(0);
    expect(score.sum).toBe(60);
  });

  it('домашнее задание засчитывается и в день экзамена', () => {
    // Из подсчёта исключён только приход — про ДЗ ТЗ оговорки не делает.
    const score = computeWeekScore([exam], [cell('d3', { attendance: null, score: 5 })], {
      bonus: 0,
      exam: 0,
    });

    expect(score.homework).toBe(5);
  });

  it('суммирует баллы за ДЗ по всем дням', () => {
    const score = computeWeekScore(
      [lecture, practice],
      [cell('d1', { score: 5 }), cell('d2', { score: 3 })],
      { bonus: 0, exam: 0 },
    );

    expect(score.homework).toBe(8);
  });

  it('нулевой балл за ДЗ отличается от непроверенного', () => {
    const zero = computeWeekScore([lecture], [cell('d1', { score: 0 })], { bonus: 0, exam: 0 });
    const missing = computeWeekScore([lecture], [cell('d1')], { bonus: 0, exam: 0 });

    expect(zero.homework).toBe(0);
    expect(missing.homework).toBe(0);
    // Разница видна не в сумме, а в самой клетке — здесь важно, что ноль
    // не ломает подсчёт, попадая в ветку «не проверено».
    expect(zero.sum).toBe(missing.sum);
  });

  it('складывает Sum = Σ(приходы) + Σ(ДЗ) + Exam + Bonus', () => {
    const score = computeWeekScore(
      [lecture, practice, exam],
      [
        cell('d1', { attendance: AttendanceMark.PRESENT, score: 5 }),
        cell('d2', { attendance: AttendanceMark.LATE, score: 4 }),
        cell('d3', { attendance: AttendanceMark.PRESENT, score: 5 }),
      ],
      { bonus: 7, exam: 60 },
    );

    expect(score).toEqual({ attendance: 2, homework: 14, exam: 60, bonus: 7, sum: 83 });
  });

  it('клетки удалённых дней в подсчёт не идут', () => {
    // День убрали из недели правкой: балл за него взялся бы из ниоткуда.
    const score = computeWeekScore(
      [lecture],
      [
        cell('d1', { attendance: AttendanceMark.PRESENT }),
        cell('d2', { attendance: AttendanceMark.PRESENT, score: 5 }),
      ],
      { bonus: 0, exam: 0 },
    );

    expect(score).toMatchObject({ attendance: 1, homework: 0, sum: 1 });
  });

  it('неделя без отметок даёт только ручные слагаемые', () => {
    const score = computeWeekScore([lecture], [], { bonus: 3, exam: 40 });

    expect(score.sum).toBe(43);
  });

  it('неделя без дней даёт ноль сверх ручных слагаемых', () => {
    const score = computeWeekScore([], [cell('d1', { attendance: AttendanceMark.PRESENT })], {
      bonus: 0,
      exam: 0,
    });

    expect(score.sum).toBe(0);
  });

  it('потолок балла за ДЗ равен пяти (ТЗ 5.8)', () => {
    expect(MAX_HOMEWORK_SCORE).toBe(5);
  });
});

describe('isArrival', () => {
  it('приходом считаются PRESENT и LATE', () => {
    expect(isArrival(AttendanceMark.PRESENT)).toBe(true);
    expect(isArrival(AttendanceMark.LATE)).toBe(true);
  });

  it('пропуск и отсутствие отметки приходом не считаются', () => {
    expect(isArrival(AttendanceMark.ABSENT)).toBe(false);
    expect(isArrival(null)).toBe(false);
  });
});
