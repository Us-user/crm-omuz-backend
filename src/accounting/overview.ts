import { fromCents } from './accounting';

/**
 * Обзор бухгалтерии (ТЗ 5.16: «Total payment / Paid / Not paid / Net;
 * Income vs Expense; Students payment по группам») — чистые функции сведения.
 *
 * Своих таблиц у обзора нет: все три витрины считаются по уже существующим
 * начислениям, платежам и расходам. Здесь только то, чего нет в запросе:
 * помесячная раскладка (в Prisma она не выражается — нужен `date_trunc`,
 * то есть сырой SQL) и свод расходов по **корневым** категориям. Тот же ход
 * и по той же причине, что в статистике оттока (0025); отрезок так же
 * ограничен сверху, поэтому набор не может вырасти до «всей истории центра»
 * случайно.
 *
 * Все суммы на входе — в тыйинах (правило 0029), наружу уходят сомони.
 */

/** Сколько месяцев показывает обзор, если период не задан. */
export const DEFAULT_OVERVIEW_MONTHS = 12;

/**
 * Потолок длины периода — как у графика оттока (0025): дело не в скорости
 * запроса, а в том, что «Income vs Expense» из трёхсот столбцов не является
 * графиком, а «выгрузить всё» не должно получаться из пустого запроса.
 */
export const MAX_OVERVIEW_MONTHS = 60;

export interface NamedRef {
  id: string;
  name: string;
}

/** Денежный факт: сумма в тыйинах и день, по которому она попадает в месяц. */
export interface MoneyFact {
  at: Date;
  cents: number;
}

/** Столбец графика «Income vs Expense» (ТЗ 5.16). Суммы — в сомони. */
export interface MonthMoney {
  month: string;
  /** Принятые за месяц деньги, включая предоплаты. */
  income: number;
  expense: number;
  /** `income − expense`. Может быть отрицательным — это законный ответ. */
  net: number;
}

/**
 * Раскладка прихода и расхода по месяцам ряда.
 *
 * Ряд задаётся снаружи (`monthSequence`), а не данными: месяц без единой
 * операции обязан остаться в графике нулём, иначе расстояние между столбцами
 * перестаёт быть временем (правило 0025).
 *
 * Факт вне ряда молча отбрасывается — выборка ограничена теми же границами,
 * и заводить столбец, которого нет в оси, значило бы показывать период шире
 * запрошенного.
 */
export function monthlyMoney(
  months: readonly string[],
  income: readonly MoneyFact[],
  expense: readonly MoneyFact[],
): MonthMoney[] {
  const incomeByMonth = sumByMonth(months, income);
  const expenseByMonth = sumByMonth(months, expense);

  return months.map((month) => {
    const incomeCents = incomeByMonth.get(month) ?? 0;
    const expenseCents = expenseByMonth.get(month) ?? 0;

    return {
      month,
      income: fromCents(incomeCents),
      expense: fromCents(expenseCents),
      // Вычитание идёт в тыйинах и только потом переводится в сомони:
      // разность округлённых сомони разошлась бы со столбцами на копейки.
      net: fromCents(incomeCents - expenseCents),
    };
  });
}

const sumByMonth = (
  months: readonly string[],
  facts: readonly MoneyFact[],
): Map<string, number> => {
  const totals = new Map(months.map((month) => [month, 0]));

  for (const fact of facts) {
    const month = fact.at.toISOString().slice(0, 7);
    const current = totals.get(month);
    if (current !== undefined) totals.set(month, current + fact.cents);
  }

  return totals;
};

/** Расход в том виде, в каком его сводит обзор. */
export interface ExpenseFact {
  categoryId: string;
  cents: number;
}

/** Категория с её местом в дереве: `parent === null` — верхний уровень. */
export interface CategoryNode {
  id: string;
  name: string;
  parent: NamedRef | null;
}

/** Строка свода расходов по категориям (ТЗ 5.16: «Expenses: категории»). */
export interface CategoryTotal {
  category: NamedRef;
  /** Сумма по категории **вместе с подкатегориями**. */
  amount: number;
  /** Доля от всех расходов периода, в процентах с двумя знаками. */
  share: number;
  /** Разбивка по подкатегориям; у листа верхнего уровня — пустой список. */
  children: { category: NamedRef; amount: number }[];
}

/**
 * Свод расходов по **корневым** категориям (ТЗ 5.16: «Tax→Income tax/VAT/
 * Property/Social, Office, Marketing, Employees»).
 *
 * Расход всегда проведён по конкретной статье, но читают отчёт разделами:
 * вопрос «сколько ушло на налоги» не должен требовать сложения четырёх строк
 * глазами. Поэтому суммы поднимаются к родителю, а подкатегории остаются
 * внутри строки — ровно та причина, по которой справочник сделан
 * двухуровневым (решение пользователя, 0030).
 *
 * Расход по неизвестной категории в свод не попадает: категории приходят
 * из того же запроса, что и факты, и отсутствие означало бы рассинхронизацию,
 * а не «прочее» — выдуманная строка «прочее» утверждала бы, что статью
 * выясняли.
 *
 * Порядок — по убыванию суммы, при равенстве по названию: первым читают
 * самое крупное, а устойчивость нужна, чтобы два вызова с теми же данными
 * давали один ответ (приём 0024, 0025).
 */
export function summarizeCategories(
  facts: readonly ExpenseFact[],
  categories: ReadonlyMap<string, CategoryNode>,
): CategoryTotal[] {
  /** Сумма одной строки свода — корневой или вложенной. */
  interface Bucket {
    category: NamedRef;
    cents: number;
  }

  const roots = new Map<string, Bucket>();
  const children = new Map<string, Map<string, Bucket>>();
  let totalCents = 0;

  for (const fact of facts) {
    const node = categories.get(fact.categoryId);
    if (node === undefined) continue;

    const root = node.parent ?? { id: node.id, name: node.name };
    const rootTotal = roots.get(root.id) ?? { category: root, cents: 0 };
    rootTotal.cents += fact.cents;
    roots.set(root.id, rootTotal);
    totalCents += fact.cents;

    if (node.parent === null) continue;

    const bucket = children.get(root.id) ?? new Map<string, Bucket>();
    const childTotal: Bucket = bucket.get(node.id) ?? {
      category: { id: node.id, name: node.name },
      cents: 0,
    };
    childTotal.cents += fact.cents;
    bucket.set(node.id, childTotal);
    children.set(root.id, bucket);
  }

  return [...roots.values()]
    .sort((a, b) => b.cents - a.cents || compareText(a.category.name, b.category.name))
    .map((root) => ({
      category: root.category,
      amount: fromCents(root.cents),
      // Ноль расходов не даёт нулевых строк: пустой свод сюда не доходит.
      share: totalCents === 0 ? 0 : Math.round((root.cents / totalCents) * 10_000) / 100,
      children: [...(children.get(root.category.id)?.values() ?? [])]
        .sort((a, b) => b.cents - a.cents || compareText(a.category.name, b.category.name))
        .map((child) => ({ category: child.category, amount: fromCents(child.cents) })),
    }));
}

/** Начисления одного студента в одной группе за период — в тыйинах. */
export interface GroupChargeFact {
  groupId: string;
  studentId: string;
  chargedCents: number;
  paidCents: number;
  debtCents: number;
}

/** Группа с курсом и филиалом — то, чем подписывается строка свода. */
export interface GroupRef {
  id: string;
  name: string;
  course: NamedRef | null;
  branch: NamedRef | null;
}

/** Строка «Students payment по группам» (ТЗ 5.16). */
export interface GroupPaymentTotal {
  group: NamedRef;
  course: NamedRef | null;
  branch: NamedRef | null;
  /** Сколько студентов группы получили начисления в этом периоде. */
  students: number;
  charged: number;
  paid: number;
  debt: number;
}

/**
 * Свод оплат по группам (ТЗ 5.16: «Students payment по группам»).
 *
 * Единица входа — пара «студент + группа», а не начисление: только так
 * считается число учеников, за которых в периоде выставлялись счета,
 * — а месяцев у каждого несколько.
 *
 * Долг берётся из остатков, а не выводится как «начислено − оплачено»:
 * это одно и то же число ровно потому, что платёж по месяцу не может
 * превышать его остаток (ключевое правило 0029), и брать хранимый остаток
 * честнее — он же стоит в строке студента.
 */
export function summarizeGroupPayments(
  facts: readonly GroupChargeFact[],
  groups: ReadonlyMap<string, GroupRef>,
): GroupPaymentTotal[] {
  const totals = new Map<
    string,
    { group: GroupRef; students: Set<string>; charged: number; paid: number; debt: number }
  >();

  for (const fact of facts) {
    const group = groups.get(fact.groupId);
    if (group === undefined) continue;

    const total = totals.get(fact.groupId) ?? {
      group,
      students: new Set<string>(),
      charged: 0,
      paid: 0,
      debt: 0,
    };

    total.students.add(fact.studentId);
    total.charged += fact.chargedCents;
    total.paid += fact.paidCents;
    total.debt += fact.debtCents;
    totals.set(fact.groupId, total);
  }

  return [...totals.values()]
    .sort((a, b) => b.charged - a.charged || compareText(a.group.name, b.group.name))
    .map((total) => ({
      group: { id: total.group.id, name: total.group.name },
      course: total.group.course,
      branch: total.group.branch,
      students: total.students.size,
      charged: fromCents(total.charged),
      paid: fromCents(total.paid),
      debt: fromCents(total.debt),
    }));
}

/**
 * Сравнение названий без учёта локали: `localeCompare` зависит от окружения,
 * а порядок внутри одинаковых сумм должен быть одним и тем же везде (0025).
 */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
