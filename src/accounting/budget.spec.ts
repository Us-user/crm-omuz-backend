import type { BudgetLineFact } from './budget';
import { BUDGET_STATUS_TITLES, spentCentsOfCategory, summarizeBudget, usageOf } from './budget';

/**
 * Правило бюджета (ТЗ 5.16) проверяется таблицей значений, а не поднятым
 * приложением: на этих числах держится ответ «уложились ли мы в план»,
 * и они не должны зависеть ни от Prisma, ни от Nest.
 */

const TAX = 'tax';
const VAT = 'vat';
const INCOME_TAX = 'income-tax';
const OFFICE = 'office';
const MARKETING = 'marketing';

const line = (overrides: Partial<BudgetLineFact> = {}): BudgetLineFact => ({
  id: 'line-1',
  categoryId: OFFICE,
  categoryName: 'Офис',
  parent: null,
  allocatedCents: 1_200_000,
  note: null,
  ...overrides,
});

/** Дерево статей: «Налоги» с двумя подстатьями, остальные — листья. */
const CHILDREN = new Map<string, string[]>([[TAX, [VAT, INCOME_TAX]]]);

describe('usageOf', () => {
  it('считает освоение плана в процентах с двумя знаками', () => {
    expect(usageOf(3_000_000, 2_840_000)).toBe(94.67);
  });

  it('перерасход даёт больше ста процентов', () => {
    expect(usageOf(1_200_000, 1_510_000)).toBe(125.83);
  });

  it('нулевой план не даёт освоения: делить не на что', () => {
    // Ноль утверждал бы «не тратили», хотя по статье могли потратить, — то же
    // соображение, что с `averageScore: null` (0019).
    expect(usageOf(0, 50_000)).toBeNull();
    expect(usageOf(0, 0)).toBeNull();
  });

  it('ничего не потрачено — ноль процентов, а не null', () => {
    expect(usageOf(1_000_000, 0)).toBe(0);
  });
});

describe('spentCentsOfCategory', () => {
  it('лист берёт только свои расходы', () => {
    const spent = new Map([[OFFICE, 450_000]]);

    expect(spentCentsOfCategory(OFFICE, spent, CHILDREN)).toBe(450_000);
  });

  it('раздел собирает расходы всех своих подстатей', () => {
    // Ровно то, ради чего справочник сделан двухуровневым (0030): «сколько ушло
    // на налоги» не должно требовать сложения четырёх строк глазами.
    const spent = new Map([
      [VAT, 800_000],
      [INCOME_TAX, 500_000],
    ]);

    expect(spentCentsOfCategory(TAX, spent, CHILDREN)).toBe(1_300_000);
  });

  it('раздел складывает и свои расходы, и расходы подстатей', () => {
    const spent = new Map([
      [TAX, 100_000],
      [VAT, 800_000],
    ]);

    expect(spentCentsOfCategory(TAX, spent, CHILDREN)).toBe(900_000);
  });

  it('статья без расходов даёт ноль, а не пропадает', () => {
    expect(spentCentsOfCategory(MARKETING, new Map(), CHILDREN)).toBe(0);
  });

  it('расходы чужого раздела в статью не попадают', () => {
    const spent = new Map([[VAT, 800_000]]);

    expect(spentCentsOfCategory(OFFICE, spent, CHILDREN)).toBe(0);
  });
});

describe('summarizeBudget', () => {
  it('считает выделено, потрачено, остаток и освоение по каждой строке', () => {
    const spent = new Map([[OFFICE, 450_000]]);

    const { lines } = summarizeBudget([line()], spent, CHILDREN);

    expect(lines).toEqual([
      {
        id: 'line-1',
        category: { id: OFFICE, name: 'Офис' },
        categoryParent: null,
        allocated: 12_000,
        spent: 4500,
        remaining: 7500,
        usage: 37.5,
        overspent: false,
        note: null,
      },
    ]);
  });

  it('перерасход даёт отрицательный остаток и поднимает флаг', () => {
    // План ничего не запрещает: расход сверх выделенного проводится и виден
    // перерасходом — это законный ответ, а не ошибка данных.
    const spent = new Map([[OFFICE, 1_510_000]]);

    const { lines, totals } = summarizeBudget([line()], spent, CHILDREN);

    expect(lines[0]).toMatchObject({ spent: 15_100, remaining: -3100, overspent: true });
    expect(totals).toMatchObject({ remaining: -3100, overspent: true });
  });

  it('план по разделу собирает расходы подстатей', () => {
    const spent = new Map([
      [VAT, 800_000],
      [INCOME_TAX, 500_000],
    ]);

    const { lines } = summarizeBudget(
      [line({ categoryId: TAX, categoryName: 'Налоги', allocatedCents: 3_000_000 })],
      spent,
      CHILDREN,
    );

    expect(lines[0]).toMatchObject({ allocated: 30_000, spent: 13_000, remaining: 17_000 });
  });

  it('складывает итоги по всем строкам плана', () => {
    const spent = new Map([
      [OFFICE, 450_000],
      [MARKETING, 325_000],
    ]);

    const { totals } = summarizeBudget(
      [
        line({ id: 'a' }),
        line({
          id: 'b',
          categoryId: MARKETING,
          categoryName: 'Маркетинг',
          allocatedCents: 800_000,
        }),
      ],
      spent,
      CHILDREN,
    );

    expect(totals).toEqual({
      allocated: 20_000,
      spent: 7750,
      remaining: 12_250,
      usage: 38.75,
      overspent: false,
    });
  });

  it('расход по незапланированной статье в план не попадает', () => {
    // Строки для него нет, и выдумывать «прочее» значило бы утверждать,
    // что статью планировали (тот же довод, что в своде обзора, 0030).
    const spent = new Map([
      [OFFICE, 450_000],
      [MARKETING, 999_900],
    ]);

    const { totals } = summarizeBudget([line()], spent, CHILDREN);

    expect(totals.spent).toBe(4500);
  });

  it('порядок строк — по убыванию выделенного, при равенстве по названию', () => {
    const rows = summarizeBudget(
      [
        line({
          id: 'a',
          categoryId: MARKETING,
          categoryName: 'Маркетинг',
          allocatedCents: 500_000,
        }),
        line({ id: 'b', categoryId: TAX, categoryName: 'Налоги', allocatedCents: 3_000_000 }),
        line({ id: 'c', allocatedCents: 500_000 }),
      ],
      new Map(),
      CHILDREN,
    ).lines;

    expect(rows.map((row) => row.category.name)).toEqual(['Налоги', 'Маркетинг', 'Офис']);
  });

  it('пустой план отдаёт нули, а не падает', () => {
    expect(summarizeBudget([], new Map(), new Map())).toEqual({
      lines: [],
      salary: null,
      totals: { allocated: 0, spent: 0, remaining: 0, usage: null, overspent: false },
    });
  });

  it('копейки не теряются: вычитание идёт в тыйинах', () => {
    // Разность округлённых сомони разошлась бы со строками на копейку —
    // ровно то, от чего защищает счёт в тыйинах (0029).
    const spent = new Map([[OFFICE, 3333]]);

    const { lines } = summarizeBudget([line({ allocatedCents: 10_000 })], spent, CHILDREN);

    expect(lines[0]).toMatchObject({ allocated: 100, spent: 33.33, remaining: 66.67 });
  });

  it('родитель статьи уходит наружу — по нему экран показывает раздел', () => {
    const { lines } = summarizeBudget(
      [line({ categoryId: VAT, categoryName: 'НДС', parent: { id: TAX, name: 'Налоги' } })],
      new Map(),
      CHILDREN,
    );

    expect(lines[0].categoryParent).toEqual({ id: TAX, name: 'Налоги' });
  });

  it('не меняет входной список', () => {
    const input = [line({ id: 'a', allocatedCents: 100 }), line({ id: 'b', allocatedCents: 900 })];
    const copy = structuredClone(input);

    summarizeBudget(input, new Map(), CHILDREN);

    expect(input).toEqual(copy);
  });
});

describe('BUDGET_STATUS_TITLES', () => {
  it('называет все три состояния плана по-русски', () => {
    expect(BUDGET_STATUS_TITLES).toEqual({
      DRAFT: 'Черновик',
      ACTIVE: 'Действует',
      CLOSED: 'Закрыт',
    });
  });
});

describe('summarizeBudget — фонд оплаты труда (ТЗ 5.16, решение 0032)', () => {
  const line = {
    id: 'l1',
    categoryId: 'office',
    categoryName: 'Офис',
    parent: null,
    allocatedCents: 1_000_000,
    note: null,
  };

  it('план фонда считается по выплатам и входит в итоги', () => {
    const summary = summarizeBudget([line], new Map([['office', 400_000]]), new Map(), {
      allocatedCents: 12_000_000,
      spentCents: 9_840_000,
    });

    expect(summary.salary).toEqual({
      allocated: 120_000,
      spent: 98_400,
      remaining: 21_600,
      usage: 82,
      overspent: false,
    });
    // Итоги складывают строки и фонд: 10 000 + 120 000 выделено, 4000 + 98 400 ушло.
    expect(summary.totals).toMatchObject({ allocated: 130_000, spent: 102_400 });
  });

  it('незапланированный фонд в итоги не входит — строки для него нет', () => {
    const summary = summarizeBudget([line], new Map([['office', 400_000]]), new Map(), {
      allocatedCents: null,
      spentCents: 9_840_000,
    });

    expect(summary.salary).toBeNull();
    expect(summary.totals).toMatchObject({ allocated: 10_000, spent: 4000 });
  });

  it('перерасход фонда виден отрицательным остатком, а не отказом', () => {
    const summary = summarizeBudget([], new Map(), new Map(), {
      allocatedCents: 100_000,
      spentCents: 150_000,
    });

    expect(summary.salary).toMatchObject({ remaining: -500, overspent: true, usage: 150 });
  });

  it('нулевой фонд освоения не даёт: делить не на что', () => {
    const summary = summarizeBudget([], new Map(), new Map(), {
      allocatedCents: 0,
      spentCents: 50_000,
    });

    expect(summary.salary).toMatchObject({ usage: null, overspent: true });
  });
});
