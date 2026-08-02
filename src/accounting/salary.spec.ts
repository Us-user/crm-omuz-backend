import {
  computeSalary,
  earnedCentsOf,
  frozenSalary,
  hoursOf,
  salaryTotalsOf,
  summarizeSalaries,
  summarizeSalaryDays,
} from './salary';

const day = (iso: string, minutes: number, groupName?: string) => ({
  date: new Date(`${iso}T00:00:00.000Z`),
  minutes,
  group: groupName === undefined ? null : { id: 'g1', name: groupName },
});

describe('hoursOf', () => {
  it('переводит минуты в часы с двумя знаками', () => {
    expect(hoursOf(90)).toBe(1.5);
    expect(hoursOf(600)).toBe(10);
  });

  it('округляет до сотых, а не до целых часов', () => {
    expect(hoursOf(100)).toBe(1.67);
  });

  it('ноль минут — ноль часов, а не null', () => {
    expect(hoursOf(0)).toBe(0);
  });
});

describe('earnedCentsOf', () => {
  it('считает «часы × ставка» с делением в конце', () => {
    // 90 минут по 27 TJS/ч = 40.50 TJS.
    expect(earnedCentsOf(90, 2700)).toBe(4050);
  });

  it('не теряет полтыйина на неровных минутах: деление идёт последним', () => {
    // Через округлённые часы (1.67 ч) вышло бы 4509 тыйин, а точное — 4500.
    expect(earnedCentsOf(100, 2700)).toBe(4500);
  });

  it('нулевая ставка даёт ноль, а не ошибку: стажёр без оплаты законен', () => {
    expect(earnedCentsOf(600, 0)).toBe(0);
  });

  it('ноль минут даёт ноль', () => {
    expect(earnedCentsOf(0, 2700)).toBe(0);
  });

  it('копейки не накапливаются: месяц считается одним умножением', () => {
    // 20 занятий по 95 минут — 1900 минут по 33.33 TJS.
    expect(earnedCentsOf(1900, 3333)).toBe(105_545);
  });
});

describe('computeSalary', () => {
  const base = {
    minutes: 600,
    hourlyRateCents: 2700,
    bonusCents: 0,
    prepaidCents: 0,
    paidCents: 0,
  };

  it('Total = заработано часами + премия', () => {
    const result = computeSalary({ ...base, bonusCents: 20_000 });

    expect(result.earnedCents).toBe(27_000);
    expect(result.totalCents).toBe(47_000);
  });

  it('Remaining = Total − Prepaid − Paid', () => {
    const result = computeSalary({ ...base, prepaidCents: 5000, paidCents: 2000 });

    expect(result.remainingCents).toBe(27_000 - 5000 - 2000);
  });

  it('Remaining уходит в минус, если аванс больше заработанного: ноль лгал бы', () => {
    const result = computeSalary({ ...base, minutes: 60, prepaidCents: 50_000 });

    expect(result.totalCents).toBe(2700);
    expect(result.remainingCents).toBe(-47_300);
  });

  it('месяц без уровня не превращает часы в деньги: earned = 0, ставка null', () => {
    const result = computeSalary({ ...base, hourlyRateCents: null });

    expect(result.hourlyRate).toBeNull();
    expect(result.earnedCents).toBe(0);
  });

  it('премия остаётся премией даже без уровня', () => {
    const result = computeSalary({ ...base, hourlyRateCents: null, bonusCents: 15_000 });

    expect(result.totalCents).toBe(15_000);
  });

  it('часы отдаются рядом с минутами — наружу уходят часы', () => {
    expect(computeSalary({ ...base, minutes: 750 }).hours).toBe(12.5);
  });

  it('ставка наружу — в сомони, а не в тыйинах', () => {
    expect(computeSalary(base).hourlyRate).toBe(27);
  });
});

describe('frozenSalary', () => {
  const snapshot = {
    minutes: 600,
    hourlyRateCents: 2700,
    totalCents: 47_000,
    bonusCents: 20_000,
    prepaidCents: 0,
    paidCents: 0,
  };

  it('берёт Total из снимка, а earned выводит вычитанием премии', () => {
    const result = frozenSalary(snapshot);

    expect(result.totalCents).toBe(47_000);
    expect(result.earnedCents).toBe(27_000);
  });

  it('не пересчитывает по живым часам: снимок и есть ответ', () => {
    // Ставку в справочнике пересмотрели, но снимок хранит прежнюю.
    const result = frozenSalary({ ...snapshot, totalCents: 47_000, hourlyRateCents: 2700 });

    expect(result.totalCents).toBe(47_000);
  });

  it('Prepaid и Paid остаются живыми: их снимок не замораживает', () => {
    const result = frozenSalary({ ...snapshot, prepaidCents: 5000, paidCents: 12_000 });

    expect(result.prepaidCents).toBe(5000);
    expect(result.paidCents).toBe(12_000);
    expect(result.remainingCents).toBe(47_000 - 5000 - 12_000);
  });

  it('снимок без ставки оставляет её null, а не нулём', () => {
    expect(frozenSalary({ ...snapshot, hourlyRateCents: null }).hourlyRate).toBeNull();
  });
});

describe('salaryTotalsOf', () => {
  it('переводит тыйины в сомони по всем четырём числам', () => {
    expect(
      salaryTotalsOf({
        totalCents: 134_750,
        prepaidCents: 40_000,
        paidCents: 50_000,
        remainingCents: 44_750,
      }),
    ).toEqual({ total: 1347.5, prepaid: 400, paid: 500, remaining: 447.5 });
  });

  it('отрицательный остаток остаётся отрицательным', () => {
    expect(
      salaryTotalsOf({
        totalCents: 1000,
        prepaidCents: 5000,
        paidCents: 0,
        remainingCents: -4000,
      }).remaining,
    ).toBe(-40);
  });
});

describe('summarizeSalaries', () => {
  const row = (over: Partial<ReturnType<typeof computeSalary>> & { confirmed?: boolean } = {}) => ({
    ...computeSalary({
      minutes: 600,
      hourlyRateCents: 2700,
      bonusCents: 0,
      prepaidCents: 0,
      paidCents: 0,
    }),
    confirmed: false,
    ...over,
  });

  it('складывает четыре числа по всему набору', () => {
    const totals = summarizeSalaries([row(), row()]);

    expect(totals.total).toBe(540);
    expect(totals.count).toBe(2);
  });

  it('считает подтверждённые отдельно от общего числа', () => {
    const totals = summarizeSalaries([row({ confirmed: true }), row(), row({ confirmed: true })]);

    expect(totals.count).toBe(3);
    expect(totals.confirmed).toBe(2);
  });

  it('часы складываются в минутах и переводятся один раз', () => {
    // Три по 100 минут: 300 мин = 5 ч. Сложение округлённых дало бы 5.01.
    const rows = [100, 100, 100].map((minutes) =>
      row(
        computeSalary({
          minutes,
          hourlyRateCents: 0,
          bonusCents: 0,
          prepaidCents: 0,
          paidCents: 0,
        }),
      ),
    );

    expect(summarizeSalaries(rows).hours).toBe(5);
  });

  it('копейки не теряются: сложение идёт в тыйинах', () => {
    const rows = [3333, 3333, 3333].map((cents) =>
      row({
        totalCents: cents,
        prepaidCents: 0,
        paidCents: 0,
        remainingCents: cents,
        minutes: 0,
      }),
    );

    expect(summarizeSalaries(rows).total).toBe(99.99);
  });

  it('пустой набор даёт нули, а не пустоту', () => {
    expect(summarizeSalaries([])).toEqual({
      count: 0,
      confirmed: 0,
      hours: 0,
      total: 0,
      prepaid: 0,
      paid: 0,
      remaining: 0,
    });
  });
});

describe('summarizeSalaryDays', () => {
  it('раскладывает месяц по дням и умножает каждый на ставку', () => {
    const days = summarizeSalaryDays([day('2026-09-07', 90, 'Frontend-1')], 2700);

    expect(days).toEqual([
      {
        date: new Date('2026-09-07T00:00:00.000Z'),
        minutes: 90,
        hours: 1.5,
        group: { id: 'g1', name: 'Frontend-1' },
        amountCents: 4050,
      },
    ]);
  });

  it('сортирует по дате независимо от порядка входа', () => {
    const days = summarizeSalaryDays(
      [day('2026-09-14', 60), day('2026-09-07', 60), day('2026-09-10', 60)],
      2700,
    );

    expect(days.map((item) => item.date.toISOString().slice(0, 10))).toEqual([
      '2026-09-07',
      '2026-09-10',
      '2026-09-14',
    ]);
  });

  it('без ставки день остаётся в раскладке с нулевой суммой, а не пропадает', () => {
    const days = summarizeSalaryDays([day('2026-09-07', 90)], null);

    expect(days).toHaveLength(1);
    expect(days[0]?.amountCents).toBe(0);
  });

  it('день без записанной длительности виден нулём часов', () => {
    const days = summarizeSalaryDays([day('2026-09-07', 0)], 2700);

    expect(days[0]?.hours).toBe(0);
    expect(days[0]?.amountCents).toBe(0);
  });

  it('занятие без группы не теряется', () => {
    expect(summarizeSalaryDays([day('2026-09-07', 60)], 2700)[0]?.group).toBeNull();
  });

  it('не меняет входной массив', () => {
    const input = [day('2026-09-14', 60), day('2026-09-07', 60)];
    summarizeSalaryDays(input, 2700);

    expect(input[0]?.date.toISOString().slice(0, 10)).toBe('2026-09-14');
  });

  it('сумма дней может разойтись с месячным итогом — округление на строку', () => {
    // Три дня по 100 минут: по строкам 3 × 4500 = 13 500, месяцем 300 × 2700 / 60 = 13 500.
    // Совпадает; расхождение появляется на ставках с копейками — проверяем именно его.
    const days = summarizeSalaryDays(
      [day('2026-09-07', 50), day('2026-09-08', 50), day('2026-09-09', 50)],
      3333,
    );
    const bySum = days.reduce((total, item) => total + item.amountCents, 0);

    expect(bySum).toBe(8334);
    expect(earnedCentsOf(150, 3333)).toBe(8333);
  });
});
