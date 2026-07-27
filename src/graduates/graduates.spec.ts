import { GraduateEmployment } from '@prisma/client';

import { employmentCountsOf, graduationDateOf } from './graduates';

describe('employmentCountsOf', () => {
  it('раскладывает агрегат по статусам ТЗ 5.11', () => {
    const counts = employmentCountsOf([
      { employment: GraduateEmployment.WORK, count: 11 },
      { employment: GraduateEmployment.OPEN_TO_WORK, count: 4 },
      { employment: GraduateEmployment.FREELANCER, count: 2 },
      { employment: GraduateEmployment.FURTHER_EDUCATION, count: 1 },
      { employment: GraduateEmployment.ENTREPRENEUR, count: 3 },
    ]);

    expect(counts).toEqual({
      [GraduateEmployment.OPEN_TO_WORK]: 4,
      [GraduateEmployment.WORK]: 11,
      [GraduateEmployment.FREELANCER]: 2,
      [GraduateEmployment.FURTHER_EDUCATION]: 1,
      [GraduateEmployment.ENTREPRENEUR]: 3,
      unknown: 0,
    });
  });

  it('невыясненный статус считается отдельно, а не как «ищет работу»', () => {
    const counts = employmentCountsOf([
      { employment: null, count: 7 },
      { employment: GraduateEmployment.OPEN_TO_WORK, count: 1 },
    ]);

    expect(counts.unknown).toBe(7);
    expect(counts[GraduateEmployment.OPEN_TO_WORK]).toBe(1);
  });

  it('статус, которого ни у кого нет, остаётся нулём, а не пропадает', () => {
    const counts = employmentCountsOf([{ employment: GraduateEmployment.WORK, count: 2 }]);

    expect(counts[GraduateEmployment.FREELANCER]).toBe(0);
    expect(Object.keys(counts)).toHaveLength(6);
  });

  it('пустой агрегат даёт нули по всем статусам', () => {
    const counts = employmentCountsOf([]);

    expect(Object.values(counts).every((count) => count === 0)).toBe(true);
  });

  it('сумма счётчиков равна числу выпускников', () => {
    const tallies = [
      { employment: GraduateEmployment.WORK, count: 5 },
      { employment: null, count: 3 },
      { employment: GraduateEmployment.ENTREPRENEUR, count: 1 },
    ];

    const total = Object.values(employmentCountsOf(tallies)).reduce((sum, n) => sum + n, 0);

    expect(total).toBe(9);
  });

  it('не зависит от порядка строк агрегата', () => {
    const a = employmentCountsOf([
      { employment: null, count: 1 },
      { employment: GraduateEmployment.WORK, count: 2 },
    ]);
    const b = employmentCountsOf([
      { employment: GraduateEmployment.WORK, count: 2 },
      { employment: null, count: 1 },
    ]);

    expect(a).toEqual(b);
  });
});

describe('graduationDateOf', () => {
  const closedAt = new Date('2026-07-28T14:35:12.000Z');

  it('берёт срок окончания группы, когда он задан', () => {
    const date = graduationDateOf(new Date('2026-06-30T00:00:00.000Z'), closedAt);

    expect(date.toISOString()).toBe('2026-06-30T00:00:00.000Z');
  });

  it('без срока группы берёт день закрытия', () => {
    const date = graduationDateOf(null, closedAt);

    expect(date.toISOString()).toBe('2026-07-28T00:00:00.000Z');
  });

  it('срезает время до полуночи UTC — колонка календарная', () => {
    const date = graduationDateOf(new Date('2026-06-30T23:59:59.999Z'), closedAt);

    expect(date.toISOString()).toBe('2026-06-30T00:00:00.000Z');
  });

  it('не трогает переданные даты', () => {
    const endDate = new Date('2026-06-30T10:00:00.000Z');
    graduationDateOf(endDate, closedAt);

    expect(endDate.toISOString()).toBe('2026-06-30T10:00:00.000Z');
  });
});
