import { AccountingPeriodStatus } from '@prisma/client';

import { parseCsv } from '../common';
import {
  formatPeriodCsv,
  frozenFactsOf,
  monthlyPeriodFacts,
  monthStartOf,
  periodReportOf,
  rangeCoversMonth,
  rangesOverlap,
  type PeriodFacts,
} from './periods';

const month = (value: string): Date => new Date(`${value}-01T00:00:00.000Z`);
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const facts = (overrides: Partial<PeriodFacts> = {}): PeriodFacts => ({
  chargedCents: 0,
  paidCents: 0,
  incomeCents: 0,
  expenseCents: 0,
  salaryCents: 0,
  ...overrides,
});

describe('periodReportOf', () => {
  it('сводит пять первичных чисел в отчёт ТЗ 5.16', () => {
    expect(
      periodReportOf({
        chargedCents: 14_800_000,
        paidCents: 12_150_000,
        incomeCents: 13_020_000,
        expenseCents: 4_280_000,
        salaryCents: 6_100_000,
      }),
    ).toEqual({
      charged: 148_000,
      paid: 121_500,
      debt: 26_500,
      income: 130_200,
      expense: 42_800,
      salary: 61_000,
      net: 26_400,
    });
  });

  it('долг — это «начислено − оплачено», тем же правилом, что в списке оплат', () => {
    expect(periodReportOf(facts({ chargedCents: 120_000, paidCents: 50_000 })).debt).toBe(700);
  });

  it('долг не уходит в минус даже на испорченных данных', () => {
    expect(periodReportOf(facts({ chargedCents: 10_000, paidCents: 30_000 })).debt).toBe(0);
  });

  it('итог отрицательный, когда центр потратил больше, чем получил', () => {
    expect(periodReportOf(facts({ incomeCents: 100_000, expenseCents: 400_000 })).net).toBe(-3000);
  });

  it('зарплата вычитается из итога отдельно от расходов (решение 0032)', () => {
    const report = periodReportOf(
      facts({ incomeCents: 100_000, expenseCents: 0, salaryCents: 20_000 }),
    );

    expect(report).toMatchObject({ expense: 0, salary: 200, net: 800 });
  });

  it('копейки не теряются: вычитание идёт в тыйинах', () => {
    // 999.99 − 333.33 − 333.33 = 333.33 ровно; сложение округлённых сомони
    // дало бы 333.32999999999998.
    expect(
      periodReportOf(facts({ incomeCents: 99_999, expenseCents: 33_333, salaryCents: 33_333 })).net,
    ).toBe(333.33);
  });

  it('пустой период — законный отчёт из нулей, а не отсутствие отчёта', () => {
    expect(periodReportOf(facts())).toEqual({
      charged: 0,
      paid: 0,
      debt: 0,
      income: 0,
      expense: 0,
      salary: 0,
      net: 0,
    });
  });
});

describe('frozenFactsOf', () => {
  const snapshot = {
    status: AccountingPeriodStatus.ARCHIVED,
    chargedCents: 100,
    paidCents: 90,
    incomeCents: 80,
    expenseCents: 70,
    salaryCents: 60,
  };

  it('отдаёт снимок закрытого периода', () => {
    expect(frozenFactsOf(snapshot)).toEqual({
      chargedCents: 100,
      paidCents: 90,
      incomeCents: 80,
      expenseCents: 70,
      salaryCents: 60,
    });
  });

  it('у периода в работе снимка нет, даже если колонки чем-то заполнены', () => {
    expect(frozenFactsOf({ ...snapshot, status: AccountingPeriodStatus.IN_PROGRESS })).toBeNull();
  });

  it('половина снимка снимком не является — числа считаются заново', () => {
    expect(frozenFactsOf({ ...snapshot, salaryCents: null })).toBeNull();
  });

  it('нули в снимке — это снимок, а не его отсутствие', () => {
    expect(
      frozenFactsOf({
        status: AccountingPeriodStatus.ARCHIVED,
        chargedCents: 0,
        paidCents: 0,
        incomeCents: 0,
        expenseCents: 0,
        salaryCents: 0,
      }),
    ).not.toBeNull();
  });
});

describe('rangesOverlap', () => {
  const range = { from: month('2026-07'), to: month('2026-09') };

  it('перекрывающиеся отрезки пересекаются', () => {
    expect(rangesOverlap(range, { from: month('2026-09'), to: month('2026-11') })).toBe(true);
  });

  it('соседние — нет: сентябрь и октябрь разные месяцы', () => {
    expect(rangesOverlap(range, { from: month('2026-10'), to: month('2026-12') })).toBe(false);
  });

  it('вложенный отрезок пересекается', () => {
    expect(rangesOverlap(range, { from: month('2026-08'), to: month('2026-08') })).toBe(true);
  });

  it('отношение симметрично — порядок аргументов ничего не меняет', () => {
    const other = { from: month('2026-06'), to: month('2026-07') };

    expect(rangesOverlap(range, other)).toBe(rangesOverlap(other, range));
  });
});

describe('rangeCoversMonth', () => {
  const range = { from: month('2026-07'), to: month('2026-09') };

  it('обе границы включающие', () => {
    expect(rangeCoversMonth(range, month('2026-07'))).toBe(true);
    expect(rangeCoversMonth(range, month('2026-09'))).toBe(true);
  });

  it('месяц за границей не накрыт', () => {
    expect(rangeCoversMonth(range, month('2026-06'))).toBe(false);
    expect(rangeCoversMonth(range, month('2026-10'))).toBe(false);
  });
});

describe('monthStartOf', () => {
  it('день операции сводится к первому числу своего месяца', () => {
    expect(monthStartOf(day('2026-08-15')).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('первое число остаётся собой', () => {
    expect(monthStartOf(day('2026-08-01')).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('последний день месяца не уезжает в следующий', () => {
    expect(monthStartOf(day('2026-12-31')).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it('время суток отбрасывается вместе с днём', () => {
    expect(monthStartOf(new Date('2026-08-15T23:59:59.999Z')).toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });
});

describe('monthlyPeriodFacts', () => {
  const months = ['2026-07', '2026-08', '2026-09'];

  it('раскладывает начисления по их месяцу обучения', () => {
    const result = monthlyPeriodFacts(
      months,
      [
        { month: month('2026-07'), chargedCents: 120_000, paidCents: 50_000 },
        { month: month('2026-09'), chargedCents: 60_000, paidCents: 60_000 },
      ],
      [],
      [],
      [],
    );

    expect(result.get('2026-07')).toMatchObject({ chargedCents: 120_000, paidCents: 50_000 });
    expect(result.get('2026-09')).toMatchObject({ chargedCents: 60_000, paidCents: 60_000 });
  });

  it('приход, расход и зарплату раскладывает по дню операции', () => {
    const result = monthlyPeriodFacts(
      months,
      [],
      [{ at: day('2026-08-15'), cents: 30_000 }],
      [{ at: day('2026-08-31'), cents: 10_000 }],
      [{ at: day('2026-09-01'), cents: 20_000 }],
    );

    expect(result.get('2026-08')).toMatchObject({ incomeCents: 30_000, expenseCents: 10_000 });
    expect(result.get('2026-09')).toMatchObject({ salaryCents: 20_000 });
  });

  it('месяц без единой операции остаётся в ряду нулями', () => {
    const result = monthlyPeriodFacts(months, [], [], [], []);

    expect(result.get('2026-08')).toEqual(facts());
    expect([...result.keys()]).toEqual(months);
  });

  it('факт вне ряда столбца не заводит', () => {
    const result = monthlyPeriodFacts(months, [], [{ at: day('2026-11-05'), cents: 999 }], [], []);

    expect([...result.keys()]).toEqual(months);
  });

  it('несколько операций одного месяца складываются', () => {
    const result = monthlyPeriodFacts(
      months,
      [],
      [
        { at: day('2026-07-01'), cents: 3333 },
        { at: day('2026-07-20'), cents: 3333 },
        { at: day('2026-07-31'), cents: 3333 },
      ],
      [],
      [],
    );

    expect(result.get('2026-07')?.incomeCents).toBe(9999);
  });
});

describe('formatPeriodCsv', () => {
  const months = ['2026-07', '2026-08'];
  const monthly = new Map([
    ['2026-07', facts({ chargedCents: 120_000, paidCents: 100_000, incomeCents: 100_000 })],
    ['2026-08', facts({ expenseCents: 30_000, salaryCents: 20_000 })],
  ]);
  const total = periodReportOf(
    facts({
      chargedCents: 120_000,
      paidCents: 100_000,
      incomeCents: 100_000,
      expenseCents: 30_000,
      salaryCents: 20_000,
    }),
  );

  /** Ячейки строк файла — номера строк здесь не проверяются. */
  const cellsOf = (csv: string): string[][] => parseCsv(csv).map((record) => record.values);

  it('строка на каждый месяц периода плюс итоговая', () => {
    const rows = cellsOf(formatPeriodCsv(months, monthly, total));

    expect(rows).toHaveLength(4);
    expect(rows[0]?.[0]).toBe('Месяц');
    expect(rows[1]?.[0]).toBe('2026-07');
    expect(rows[2]?.[0]).toBe('2026-08');
    expect(rows[3]?.[0]).toBe('Итого');
  });

  it('колонки идут в том же порядке, что числа карточки', () => {
    const rows = cellsOf(formatPeriodCsv(months, monthly, total));

    expect(rows[0]).toEqual([
      'Месяц',
      'Начислено',
      'Оплачено',
      'Долг',
      'Приход',
      'Расход',
      'Зарплата',
      'Итог',
    ]);
    // Июль: начислено 1200, оплачено 1000, долг 200, приход 1000, итог 1000.
    expect(rows[1]).toEqual([
      '2026-07',
      '1200.00',
      '1000.00',
      '200.00',
      '1000.00',
      '0.00',
      '0.00',
      '1000.00',
    ]);
  });

  it('итог приходит снаружи, а не складывается из строк', () => {
    // Итог намеренно расходится с месяцами: так выглядит закрытый период,
    // кассу которого правили после закрытия (0032, 0033).
    const rows = cellsOf(
      formatPeriodCsv(months, monthly, periodReportOf(facts({ incomeCents: 777 }))),
    );

    expect(rows[3]).toEqual(['Итого', '0.00', '0.00', '0.00', '7.77', '0.00', '0.00', '7.77']);
  });

  it('месяц без операций остаётся в файле нулями, а не пропадает', () => {
    const rows = cellsOf(formatPeriodCsv(['2026-07', '2026-08', '2026-09'], monthly, total));

    expect(rows).toHaveLength(5);
    expect(rows[3]).toEqual(['2026-09', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00']);
  });

  it('файл начинается с BOM — иначе Excel читает UTF-8 как cp1251', () => {
    expect(formatPeriodCsv(months, monthly, total).startsWith('﻿')).toBe(true);
  });

  it('суммы пишутся с двумя знаками: 0 — это «0.00», а не «0»', () => {
    const rows = cellsOf(formatPeriodCsv(['2026-07'], new Map(), periodReportOf(facts())));

    expect(rows[1]).toEqual(['2026-07', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00']);
  });

  it('пустой период выгружается как заголовок и одна итоговая строка', () => {
    const rows = cellsOf(formatPeriodCsv([], new Map(), periodReportOf(facts())));

    expect(rows).toHaveLength(2);
    expect(rows[1]?.[0]).toBe('Итого');
  });
});
