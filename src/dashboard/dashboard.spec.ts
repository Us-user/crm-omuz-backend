import { AttendanceMark, GraduateEmployment } from '@prisma/client';

import { monthSequence, parseIsoMonth } from '../common';
import type { GraduateEmploymentCounts } from '../graduates/graduates';
import type { AttendanceFact, AttendanceTally, LeadFact, NamedRef } from './dashboard';
import {
  compareMoney,
  countByMonth,
  DEFAULT_DASHBOARD_MONTHS,
  EMPLOYED_STATUSES,
  MAX_DASHBOARD_MONTHS,
  monthlyAttendance,
  summarizeEmployment,
  summarizeLeads,
  tallyAttendance,
} from './dashboard';

const month = (value: string): Date => parseIsoMonth(value, 'month');

const ref = (id: string, name: string): NamedRef => ({ id, name });

const FRONTEND = ref('c-1', 'Frontend Basic');
const PYTHON = ref('c-2', 'Python Basic');

const tally = (mark: AttendanceMark, count: number): AttendanceTally => ({ mark, count });

const fact = (at: string, mark: AttendanceMark, count: number): AttendanceFact => ({
  at: new Date(at),
  mark,
  count,
});

const lead = (at: string, overrides: Partial<LeadFact> = {}): LeadFact => ({
  at: new Date(at),
  client: false,
  converted: false,
  utmSource: null,
  course: null,
  ...overrides,
});

const counts = (overrides: Partial<GraduateEmploymentCounts> = {}): GraduateEmploymentCounts => ({
  [GraduateEmployment.OPEN_TO_WORK]: 0,
  [GraduateEmployment.WORK]: 0,
  [GraduateEmployment.FREELANCER]: 0,
  [GraduateEmployment.FURTHER_EDUCATION]: 0,
  [GraduateEmployment.ENTREPRENEUR]: 0,
  unknown: 0,
  ...overrides,
});

describe('Константы периода дашборда', () => {
  it('по умолчанию показывается год — как у оттока и обзора', () => {
    expect(DEFAULT_DASHBOARD_MONTHS).toBe(12);
  });

  it('потолок периода тот же, что у остальных отчётов', () => {
    expect(MAX_DASHBOARD_MONTHS).toBe(60);
  });
});

describe('countByMonth', () => {
  const months = monthSequence(month('2026-04'), month('2026-06'));

  it('раскладывает даты по месяцам ряда', () => {
    expect(
      countByMonth(months, [
        new Date('2026-04-03T00:00:00.000Z'),
        new Date('2026-06-20T00:00:00.000Z'),
        new Date('2026-06-01T00:00:00.000Z'),
      ]),
    ).toEqual([
      { month: '2026-04', count: 1 },
      { month: '2026-05', count: 0 },
      { month: '2026-06', count: 2 },
    ]);
  });

  it('месяц без событий остаётся в ряду с нулём', () => {
    expect(countByMonth(months, [])).toEqual([
      { month: '2026-04', count: 0 },
      { month: '2026-05', count: 0 },
      { month: '2026-06', count: 0 },
    ]);
  });

  it('дата вне ряда столбца не заводит', () => {
    const row = countByMonth(months, [new Date('2026-09-10T00:00:00.000Z')]);

    expect(row).toHaveLength(3);
    expect(row.every(({ count }) => count === 0)).toBe(true);
  });

  it('последний день месяца не уезжает в следующий', () => {
    expect(countByMonth(months, [new Date('2026-04-30T23:59:59.000Z')])[0]).toEqual({
      month: '2026-04',
      count: 1,
    });
  });

  it('пустой ряд месяцев даёт пустой ответ', () => {
    expect(countByMonth([], [new Date('2026-04-03T00:00:00.000Z')])).toEqual([]);
  });
});

describe('tallyAttendance', () => {
  it('считает приходы, опоздания и пропуски', () => {
    expect(
      tallyAttendance([
        tally(AttendanceMark.PRESENT, 18),
        tally(AttendanceMark.LATE, 2),
        tally(AttendanceMark.ABSENT, 5),
      ]),
    ).toEqual({ present: 18, late: 2, absent: 5, marked: 25, attendanceRate: 80 });
  });

  it('опоздание считается приходом (ТЗ 5.8)', () => {
    const totals = tallyAttendance([tally(AttendanceMark.LATE, 4)]);

    expect(totals.attendanceRate).toBe(100);
    expect(totals.late).toBe(4);
    expect(totals.present).toBe(0);
  });

  it('без отметок доли нет — это null, а не ноль', () => {
    expect(tallyAttendance([])).toEqual({
      present: 0,
      late: 0,
      absent: 0,
      marked: 0,
      attendanceRate: null,
    });
  });

  it('одни пропуски дают нулевую долю, а не отсутствие доли', () => {
    expect(tallyAttendance([tally(AttendanceMark.ABSENT, 3)]).attendanceRate).toBe(0);
  });

  it('доля округляется до двух знаков', () => {
    expect(
      tallyAttendance([tally(AttendanceMark.PRESENT, 5), tally(AttendanceMark.ABSENT, 1)])
        .attendanceRate,
    ).toBe(83.33);
  });

  it('несколько строк одной марки складываются', () => {
    expect(
      tallyAttendance([tally(AttendanceMark.PRESENT, 3), tally(AttendanceMark.PRESENT, 4)]).present,
    ).toBe(7);
  });

  it('от порядка строк не зависит', () => {
    const direct = tallyAttendance([
      tally(AttendanceMark.PRESENT, 4),
      tally(AttendanceMark.ABSENT, 1),
    ]);
    const reversed = tallyAttendance([
      tally(AttendanceMark.ABSENT, 1),
      tally(AttendanceMark.PRESENT, 4),
    ]);

    expect(reversed).toEqual(direct);
  });
});

describe('monthlyAttendance', () => {
  const months = monthSequence(month('2026-04'), month('2026-06'));

  it('раскладывает отметки по месяцам занятий', () => {
    expect(
      monthlyAttendance(months, [
        fact('2026-04-06T00:00:00.000Z', AttendanceMark.PRESENT, 10),
        fact('2026-06-01T00:00:00.000Z', AttendanceMark.PRESENT, 8),
        fact('2026-06-01T00:00:00.000Z', AttendanceMark.ABSENT, 2),
      ]),
    ).toEqual([
      { month: '2026-04', present: 10, late: 0, absent: 0, marked: 10, attendanceRate: 100 },
      { month: '2026-05', present: 0, late: 0, absent: 0, marked: 0, attendanceRate: null },
      { month: '2026-06', present: 8, late: 0, absent: 2, marked: 10, attendanceRate: 80 },
    ]);
  });

  it('месяц без занятий остаётся столбцом с null-долей, а не пропадает', () => {
    expect(monthlyAttendance(months, [])).toHaveLength(3);
  });

  it('отметка вне ряда столбца не заводит', () => {
    const row = monthlyAttendance(months, [
      fact('2026-09-10T00:00:00.000Z', AttendanceMark.PRESENT, 5),
    ]);

    expect(row).toHaveLength(3);
    expect(row.every(({ marked }) => marked === 0)).toBe(true);
  });

  it('дни одного месяца складываются в один столбец', () => {
    expect(
      monthlyAttendance(months, [
        fact('2026-04-06T00:00:00.000Z', AttendanceMark.PRESENT, 10),
        fact('2026-04-08T00:00:00.000Z', AttendanceMark.PRESENT, 12),
      ])[0]?.present,
    ).toBe(22);
  });

  it('столбец считается тем же правилом, что и итог', () => {
    const facts = [
      fact('2026-04-06T00:00:00.000Z', AttendanceMark.PRESENT, 5),
      fact('2026-04-08T00:00:00.000Z', AttendanceMark.LATE, 1),
      fact('2026-04-08T00:00:00.000Z', AttendanceMark.ABSENT, 2),
    ];

    expect(monthlyAttendance(months, facts)[0]).toEqual({
      month: '2026-04',
      ...tallyAttendance(facts),
    });
  });
});

describe('summarizeLeads', () => {
  const months = monthSequence(month('2026-04'), month('2026-06'));

  it('считает итоги воронки и доли', () => {
    const summary = summarizeLeads(
      [
        lead('2026-04-03T10:00:00.000Z'),
        lead('2026-04-10T10:00:00.000Z', { client: true }),
        lead('2026-05-02T10:00:00.000Z', { client: true, converted: true }),
        lead('2026-06-11T10:00:00.000Z'),
      ],
      months,
    );

    expect(summary.totals).toEqual({
      total: 4,
      leads: 2,
      clients: 2,
      converted: 1,
      clientRate: 50,
      conversionRate: 25,
    });
  });

  it('строка месяца — когорта: клиенты считаются среди обращений этого месяца', () => {
    const summary = summarizeLeads(
      [
        lead('2026-04-03T10:00:00.000Z', { client: true, converted: true }),
        lead('2026-04-05T10:00:00.000Z'),
        lead('2026-06-11T10:00:00.000Z', { client: true }),
      ],
      months,
    );

    expect(summary.byMonth).toEqual([
      { month: '2026-04', total: 2, clients: 1, converted: 1 },
      { month: '2026-05', total: 0, clients: 0, converted: 0 },
      { month: '2026-06', total: 1, clients: 1, converted: 0 },
    ]);
  });

  it('месяц без обращений остаётся в ряду нулями', () => {
    expect(summarizeLeads([], months).byMonth).toEqual([
      { month: '2026-04', total: 0, clients: 0, converted: 0 },
      { month: '2026-05', total: 0, clients: 0, converted: 0 },
      { month: '2026-06', total: 0, clients: 0, converted: 0 },
    ]);
  });

  it('на пустом периоде долей нет — это null, а не ноль', () => {
    expect(summarizeLeads([], months).totals).toEqual({
      total: 0,
      leads: 0,
      clients: 0,
      converted: 0,
      clientRate: null,
      conversionRate: null,
    });
  });

  it('обращение вне ряда в итоги входит, а столбца не заводит', () => {
    const summary = summarizeLeads([lead('2026-09-01T10:00:00.000Z')], months);

    expect(summary.totals.total).toBe(1);
    expect(summary.byMonth.every(({ total }) => total === 0)).toBe(true);
  });

  it('группирует по UTM-метке по убыванию числа', () => {
    const summary = summarizeLeads(
      [
        lead('2026-04-01T10:00:00.000Z', { utmSource: 'instagram' }),
        lead('2026-04-02T10:00:00.000Z', { utmSource: 'google' }),
        lead('2026-04-03T10:00:00.000Z', { utmSource: 'instagram' }),
      ],
      months,
    );

    expect(summary.byUtmSource).toEqual([
      { source: 'instagram', count: 2 },
      { source: 'google', count: 1 },
    ]);
  });

  it('обращения без метки собираются в одну строку с null, а не рассыпаются', () => {
    const summary = summarizeLeads(
      [lead('2026-04-01T10:00:00.000Z'), lead('2026-04-02T10:00:00.000Z')],
      months,
    );

    expect(summary.byUtmSource).toEqual([{ source: null, count: 2 }]);
  });

  it('при равном числе порядок меток закреплён названием', () => {
    const summary = summarizeLeads(
      [
        lead('2026-04-01T10:00:00.000Z', { utmSource: 'instagram' }),
        lead('2026-04-02T10:00:00.000Z', { utmSource: 'google' }),
      ],
      months,
    );

    expect(summary.byUtmSource.map(({ source }) => source)).toEqual(['google', 'instagram']);
  });

  it('при равном числе строка «без метки» уходит вниз, а не в голову списка', () => {
    const summary = summarizeLeads(
      [lead('2026-04-01T10:00:00.000Z'), lead('2026-04-02T10:00:00.000Z', { utmSource: 'google' })],
      months,
    );

    expect(summary.byUtmSource).toEqual([
      { source: 'google', count: 1 },
      { source: null, count: 1 },
    ]);
  });

  it('группирует по курсу, курс без указания идёт строкой null', () => {
    const summary = summarizeLeads(
      [
        lead('2026-04-01T10:00:00.000Z', { course: FRONTEND }),
        lead('2026-04-02T10:00:00.000Z', { course: FRONTEND }),
        lead('2026-04-03T10:00:00.000Z', { course: PYTHON }),
        lead('2026-04-04T10:00:00.000Z'),
      ],
      months,
    );

    expect(summary.byCourse).toEqual([
      { course: FRONTEND, count: 2 },
      { course: PYTHON, count: 1 },
      { course: null, count: 1 },
    ]);
  });

  it('сумма столбцов равна числу обращений периода', () => {
    const facts = [
      lead('2026-04-01T10:00:00.000Z'),
      lead('2026-05-01T10:00:00.000Z'),
      lead('2026-06-01T10:00:00.000Z'),
    ];
    const summary = summarizeLeads(facts, months);

    expect(summary.byMonth.reduce((sum, { total }) => sum + total, 0)).toBe(summary.totals.total);
  });

  it('вход не изменяется', () => {
    const facts = [lead('2026-04-01T10:00:00.000Z', { course: FRONTEND })];
    const snapshot = JSON.stringify(facts);

    summarizeLeads(facts, months);

    expect(JSON.stringify(facts)).toBe(snapshot);
  });
});

describe('compareMoney', () => {
  it('считает рост в сомони и процентах', () => {
    expect(compareMoney(120_000, 100_000)).toEqual({
      current: 1200,
      previous: 1000,
      change: 200,
      changePercent: 20,
    });
  });

  it('падение даёт отрицательные change и changePercent', () => {
    expect(compareMoney(80_000, 100_000)).toEqual({
      current: 800,
      previous: 1000,
      change: -200,
      changePercent: -20,
    });
  });

  it('с нулевого предыдущего месяца рост не считается — это null, а не 100 %', () => {
    expect(compareMoney(50_000, 0)).toEqual({
      current: 500,
      previous: 0,
      change: 500,
      changePercent: null,
    });
  });

  it('два пустых месяца дают нули и null', () => {
    expect(compareMoney(0, 0)).toEqual({
      current: 0,
      previous: 0,
      change: 0,
      changePercent: null,
    });
  });

  it('копейки не теряются: разность считается в тыйинах', () => {
    // 1200.30 − 400.10 в сомони дало бы 800.1999999999999.
    expect(compareMoney(120_030, 40_010).change).toBe(800.2);
  });

  it('процент округляется до двух знаков', () => {
    expect(compareMoney(100_000, 30_000).changePercent).toBe(233.33);
  });
});

describe('summarizeEmployment', () => {
  it('считает трудоустроенных и долю среди выясненных', () => {
    expect(
      summarizeEmployment(
        counts({
          [GraduateEmployment.WORK]: 5,
          [GraduateEmployment.FREELANCER]: 2,
          [GraduateEmployment.OPEN_TO_WORK]: 3,
          unknown: 4,
        }),
      ),
    ).toEqual({
      total: 14,
      employment: expect.objectContaining({ [GraduateEmployment.WORK]: 5 }) as unknown,
      employed: 7,
      employmentRate: 70,
    });
  });

  it('продолжившие учёбу трудоустроенными не считаются', () => {
    const summary = summarizeEmployment(
      counts({ [GraduateEmployment.FURTHER_EDUCATION]: 4, [GraduateEmployment.WORK]: 1 }),
    );

    expect(summary.employed).toBe(1);
    expect(summary.employmentRate).toBe(20);
  });

  it('невыясненные в знаменатель доли не входят', () => {
    expect(summarizeEmployment(counts({ [GraduateEmployment.WORK]: 2, unknown: 8 }))).toEqual({
      total: 10,
      employment: expect.objectContaining({ unknown: 8 }) as unknown,
      employed: 2,
      employmentRate: 100,
    });
  });

  it('если статус не выяснен ни у кого, доли нет — это null', () => {
    expect(summarizeEmployment(counts({ unknown: 6 })).employmentRate).toBeNull();
  });

  it('на пустом наборе всё нули, а доля null', () => {
    expect(summarizeEmployment(counts())).toEqual({
      total: 0,
      employment: counts(),
      employed: 0,
      employmentRate: null,
    });
  });

  it('трудоустроенными считаются ровно три статуса', () => {
    expect([...EMPLOYED_STATUSES].sort()).toEqual(
      [
        GraduateEmployment.ENTREPRENEUR,
        GraduateEmployment.FREELANCER,
        GraduateEmployment.WORK,
      ].sort(),
    );
  });

  it('счётчики отдаются как есть — витрина их не переписывает', () => {
    const input = counts({ [GraduateEmployment.ENTREPRENEUR]: 3 });

    expect(summarizeEmployment(input).employment).toEqual(input);
  });
});
