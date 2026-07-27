import { parseIsoMonth } from '../common';
import type { LeftCourseFact, NamedRef } from './left-courses';
import { monthSequence, summarize } from './left-courses';

const month = (value: string): Date => parseIsoMonth(value, 'month');

const ref = (id: string, name: string): NamedRef => ({ id, name });

const FRONTEND = ref('c-1', 'Frontend Basic');
const PYTHON = ref('c-2', 'Python Basic');
const SADBARG = ref('b-1', 'Sadbarg');
const PROFSOUS = ref('b-2', 'Profsous');

const fact = (
  leftAt: string,
  group: NamedRef = ref('g-1', 'Frontend-1'),
  course: NamedRef = FRONTEND,
  branch: NamedRef = SADBARG,
): LeftCourseFact => ({ leftAt: new Date(leftAt), group, course, branch });

describe('monthSequence', () => {
  it('перечисляет месяцы отрезка включительно', () => {
    expect(monthSequence(month('2026-04'), month('2026-07'))).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
    ]);
  });

  it('отрезок из одного месяца — один столбец', () => {
    expect(monthSequence(month('2026-06'), month('2026-06'))).toEqual(['2026-06']);
  });

  it('переносит год через декабрь', () => {
    expect(monthSequence(month('2025-11'), month('2026-02'))).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });

  it('перевёрнутый отрезок даёт пустой ряд, а не бесконечный', () => {
    expect(monthSequence(month('2026-07'), month('2026-04'))).toEqual([]);
  });

  it('год — это двенадцать столбцов', () => {
    expect(monthSequence(month('2025-08'), month('2026-07'))).toHaveLength(12);
  });
});

describe('summarize', () => {
  const months = monthSequence(month('2026-04'), month('2026-06'));

  it('считает уходы по месяцам', () => {
    const summary = summarize(
      [
        fact('2026-04-03T10:00:00.000Z'),
        fact('2026-06-20T10:00:00.000Z'),
        fact('2026-06-28T10:00:00.000Z'),
      ],
      months,
    );

    expect(summary.total).toBe(3);
    expect(summary.byMonth).toEqual([
      { month: '2026-04', count: 1 },
      { month: '2026-05', count: 0 },
      { month: '2026-06', count: 2 },
    ]);
  });

  // Главное свойство ряда: пустой месяц остаётся столбцом с нулём. Иначе
  // расстояние между столбцами перестанет быть временем.
  it('месяцы без уходов остаются в ряду с нулём', () => {
    const summary = summarize([], months);

    expect(summary.total).toBe(0);
    expect(summary.byMonth).toEqual([
      { month: '2026-04', count: 0 },
      { month: '2026-05', count: 0 },
      { month: '2026-06', count: 0 },
    ]);
  });

  it('пустой ряд месяцев не мешает посчитать общее число', () => {
    const summary = summarize([fact('2026-04-03T10:00:00.000Z')], []);

    expect(summary.total).toBe(1);
    expect(summary.byMonth).toEqual([]);
  });

  it('уход вне ряда столбца не заводит', () => {
    const summary = summarize([fact('2026-01-03T10:00:00.000Z')], months);

    expect(summary.byMonth.map(({ month: value }) => value)).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
    ]);
  });

  it('разрез по группам несёт курс группы', () => {
    const summary = summarize(
      [
        fact('2026-04-03T10:00:00.000Z', ref('g-1', 'Frontend-1'), FRONTEND),
        fact('2026-05-03T10:00:00.000Z', ref('g-2', 'Python-1'), PYTHON),
        fact('2026-06-03T10:00:00.000Z', ref('g-2', 'Python-1'), PYTHON),
      ],
      months,
    );

    expect(summary.byGroup).toEqual([
      { group: ref('g-2', 'Python-1'), course: PYTHON, count: 2 },
      { group: ref('g-1', 'Frontend-1'), course: FRONTEND, count: 1 },
    ]);
  });

  it('разрез по курсам складывает группы одного курса', () => {
    const summary = summarize(
      [
        fact('2026-04-03T10:00:00.000Z', ref('g-1', 'Frontend-1'), FRONTEND),
        fact('2026-05-03T10:00:00.000Z', ref('g-3', 'Frontend-2'), FRONTEND),
        fact('2026-06-03T10:00:00.000Z', ref('g-2', 'Python-1'), PYTHON),
      ],
      months,
    );

    expect(summary.byCourse).toEqual([
      { ref: FRONTEND, count: 2 },
      { ref: PYTHON, count: 1 },
    ]);
    expect(summary.byGroup).toHaveLength(3);
  });

  it('разрез по филиалам (ТЗ 3.3)', () => {
    const summary = summarize(
      [
        fact('2026-04-03T10:00:00.000Z', ref('g-1', 'Frontend-1'), FRONTEND, PROFSOUS),
        fact('2026-05-03T10:00:00.000Z', ref('g-2', 'Python-1'), PYTHON, PROFSOUS),
        fact('2026-06-03T10:00:00.000Z', ref('g-3', 'Frontend-2'), FRONTEND, SADBARG),
      ],
      months,
    );

    expect(summary.byBranch).toEqual([
      { ref: PROFSOUS, count: 2 },
      { ref: SADBARG, count: 1 },
    ]);
  });

  // Порядок внутри одинаковых счётчиков должен быть один и тот же от вызова
  // к вызову, иначе два запроса с теми же данными дадут разные ответы.
  it('при равенстве счётчиков порядок задан названием', () => {
    const summary = summarize(
      [
        fact('2026-04-03T10:00:00.000Z', ref('g-2', 'Python-1'), PYTHON),
        fact('2026-05-03T10:00:00.000Z', ref('g-1', 'Frontend-1'), FRONTEND),
      ],
      months,
    );

    expect(summary.byGroup.map(({ group }) => group.name)).toEqual(['Frontend-1', 'Python-1']);
    expect(summary.byCourse.map(({ ref: value }) => value.name)).toEqual([
      'Frontend Basic',
      'Python Basic',
    ]);
  });

  it('порядок фактов на ответ не влияет', () => {
    const facts = [
      fact('2026-06-03T10:00:00.000Z', ref('g-2', 'Python-1'), PYTHON),
      fact('2026-04-03T10:00:00.000Z', ref('g-1', 'Frontend-1'), FRONTEND),
      fact('2026-05-03T10:00:00.000Z', ref('g-2', 'Python-1'), PYTHON),
    ];

    expect(summarize(facts, months)).toEqual(summarize([...facts].reverse(), months));
  });

  it('сумма столбцов равна числу уходов внутри ряда', () => {
    const summary = summarize(
      [fact('2026-04-03T10:00:00.000Z'), fact('2026-06-03T10:00:00.000Z')],
      months,
    );

    expect(summary.byMonth.reduce((sum, { count }) => sum + count, 0)).toBe(summary.total);
  });

  it('не изменяет переданный список фактов', () => {
    const facts = [fact('2026-04-03T10:00:00.000Z')];
    const copy = [...facts];

    summarize(facts, months);

    expect(facts).toEqual(copy);
  });
});
