import { monthSequence, parseIsoMonth } from '../common';
import type { CategoryNode, ExpenseFact, GroupChargeFact, GroupRef, MoneyFact } from './overview';
import { monthlyMoney, summarizeCategories, summarizeGroupPayments } from './overview';

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const months = (from: string, to: string): string[] =>
  monthSequence(parseIsoMonth(from, 'from'), parseIsoMonth(to, 'to'));

const money = (at: string, cents: number): MoneyFact => ({ at: day(at), cents });

describe('monthlyMoney — график «Income vs Expense» (ТЗ 5.16)', () => {
  it('раскладывает приход и расход по месяцам ряда', () => {
    const row = monthlyMoney(
      months('2026-07', '2026-09'),
      [money('2026-07-03', 120000), money('2026-07-28', 30000), money('2026-09-01', 50000)],
      [money('2026-07-15', 40000), money('2026-08-02', 25000)],
    );

    expect(row).toEqual([
      { month: '2026-07', income: 1500, expense: 400, net: 1100 },
      { month: '2026-08', income: 0, expense: 250, net: -250 },
      { month: '2026-09', income: 500, expense: 0, net: 500 },
    ]);
  });

  it('оставляет пустой месяц в ряду нулём, а не выбрасывает его', () => {
    const row = monthlyMoney(months('2026-01', '2026-03'), [money('2026-03-10', 1000)], []);

    expect(row.map(({ month }) => month)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('net уходит в минус, когда расход больше прихода — это законный ответ', () => {
    const [row] = monthlyMoney(
      months('2026-05', '2026-05'),
      [money('2026-05-01', 10000)],
      [money('2026-05-02', 35000)],
    );

    expect(row).toEqual({ month: '2026-05', income: 100, expense: 350, net: -250 });
  });

  it('копейки не теряются: разность считается в тыйинах', () => {
    // 1200.30 − 400.10 в двоичной плавающей точке даёт 800.1999999999999.
    const [row] = monthlyMoney(
      months('2026-05', '2026-05'),
      [money('2026-05-01', 120030)],
      [money('2026-05-02', 40010)],
    );

    expect(row.net).toBe(800.2);
  });

  it('факт вне ряда не заводит столбца, которого нет в оси', () => {
    const row = monthlyMoney(months('2026-05', '2026-05'), [money('2026-04-30', 99900)], []);

    expect(row).toEqual([{ month: '2026-05', income: 0, expense: 0, net: 0 }]);
  });
});

describe('summarizeCategories — свод расходов по статьям (ТЗ 5.16)', () => {
  const TAX: CategoryNode = { id: 'tax', name: 'Налоги', parent: null };
  const VAT: CategoryNode = { id: 'vat', name: 'НДС', parent: { id: 'tax', name: 'Налоги' } };
  const INCOME_TAX: CategoryNode = {
    id: 'income-tax',
    name: 'Подоходный налог',
    parent: { id: 'tax', name: 'Налоги' },
  };
  const OFFICE: CategoryNode = { id: 'office', name: 'Офис', parent: null };

  const catalog = new Map([TAX, VAT, INCOME_TAX, OFFICE].map((node) => [node.id, node]));
  const fact = (categoryId: string, cents: number): ExpenseFact => ({ categoryId, cents });

  it('поднимает суммы подкатегорий к родителю и оставляет разбивку внутри', () => {
    const rows = summarizeCategories(
      [fact('vat', 120000), fact('income-tax', 80000), fact('office', 50000)],
      catalog,
    );

    expect(rows[0]).toEqual({
      category: { id: 'tax', name: 'Налоги' },
      amount: 2000,
      share: 80,
      children: [
        { category: { id: 'vat', name: 'НДС' }, amount: 1200 },
        { category: { id: 'income-tax', name: 'Подоходный налог' }, amount: 800 },
      ],
    });
    expect(rows[1]).toEqual({
      category: { id: 'office', name: 'Офис' },
      amount: 500,
      share: 20,
      children: [],
    });
  });

  it('расход, проведённый прямо по разделу, складывается с подкатегориями', () => {
    const [row] = summarizeCategories([fact('tax', 10000), fact('vat', 30000)], catalog);

    expect(row.amount).toBe(400);
    // Сам раздел в разбивку не попадает: он и есть строка.
    expect(row.children).toEqual([{ category: { id: 'vat', name: 'НДС' }, amount: 300 }]);
  });

  it('сортирует по убыванию суммы, при равенстве — по названию', () => {
    const rows = summarizeCategories([fact('tax', 50000), fact('office', 50000)], catalog);

    expect(rows.map(({ category }) => category.name)).toEqual(['Налоги', 'Офис']);
  });

  it('расход по неизвестной категории в свод не попадает', () => {
    const rows = summarizeCategories([fact('office', 10000), fact('ghost', 90000)], catalog);

    expect(rows).toEqual([
      { category: { id: 'office', name: 'Офис' }, amount: 100, share: 100, children: [] },
    ]);
  });

  it('на пустом наборе возвращает пустой свод, а не строку с нулём', () => {
    expect(summarizeCategories([], catalog)).toEqual([]);
  });

  it('доля считается в процентах с двумя знаками', () => {
    const rows = summarizeCategories([fact('tax', 10000), fact('office', 20000)], catalog);

    expect(rows.map(({ share }) => share)).toEqual([66.67, 33.33]);
  });
});

describe('summarizeGroupPayments — «Students payment по группам» (ТЗ 5.16)', () => {
  const FRONTEND: GroupRef = {
    id: 'g-1',
    name: 'Frontend-1',
    course: { id: 'c-1', name: 'Frontend Basic' },
    branch: { id: 'b-1', name: 'Sadbarg' },
  };
  const PYTHON: GroupRef = {
    id: 'g-2',
    name: 'Python-1',
    course: { id: 'c-2', name: 'Python Basic' },
    branch: null,
  };

  const groups = new Map([FRONTEND, PYTHON].map((group) => [group.id, group]));

  const fact = (
    groupId: string,
    studentId: string,
    charged: number,
    paid: number,
    debt: number,
  ): GroupChargeFact => ({
    groupId,
    studentId,
    chargedCents: charged,
    paidCents: paid,
    debtCents: debt,
  });

  it('считает учеников по парам «студент + группа», а не по начислениям', () => {
    // Пара приходит одной строкой на все свои месяцы: три месяца одного
    // студента — это один ученик, а не три.
    const [row] = summarizeGroupPayments(
      [fact('g-1', 's-1', 90000, 60000, 30000), fact('g-1', 's-2', 30000, 30000, 0)],
      groups,
    );

    expect(row).toEqual({
      group: { id: 'g-1', name: 'Frontend-1' },
      course: { id: 'c-1', name: 'Frontend Basic' },
      branch: { id: 'b-1', name: 'Sadbarg' },
      students: 2,
      charged: 1200,
      paid: 900,
      debt: 300,
    });
  });

  it('сортирует по убыванию начисленного, при равенстве — по названию группы', () => {
    const rows = summarizeGroupPayments(
      [fact('g-2', 's-3', 200000, 0, 200000), fact('g-1', 's-1', 90000, 90000, 0)],
      groups,
    );

    expect(rows.map(({ group }) => group.name)).toEqual(['Python-1', 'Frontend-1']);
  });

  it('группа без филиала остаётся в своде с `null`, а не выпадает', () => {
    const [row] = summarizeGroupPayments([fact('g-2', 's-3', 10000, 0, 10000)], groups);

    expect(row.branch).toBeNull();
  });

  it('начисление неизвестной группы в свод не попадает', () => {
    expect(summarizeGroupPayments([fact('ghost', 's-1', 10000, 0, 10000)], groups)).toEqual([]);
  });

  it('суммы складываются в тыйинах и переводятся один раз', () => {
    // Три платежа по 33.33 дают ровно 99.99, а не 99.99000000000001.
    const [row] = summarizeGroupPayments(
      [
        fact('g-1', 's-1', 3333, 3333, 0),
        fact('g-1', 's-2', 3333, 3333, 0),
        fact('g-1', 's-3', 3333, 3333, 0),
      ],
      groups,
    );

    expect(row.charged).toBe(99.99);
    expect(row.students).toBe(3);
  });
});
