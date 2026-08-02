import { BudgetStatus } from '@prisma/client';

import { fromCents } from './accounting';

/**
 * Бюджет центра (ТЗ 5.16: «Budget: план по категориям — allocated/spent,
 * период, статус») — чистые функции сведения, без Prisma и без Nest.
 *
 * Главное правило здесь одно, и оно объясняет всю форму модуля: **`spent`
 * не хранится**. Сколько собирались потратить — это план, сколько потратили —
 * это расходы, и второе уже записано в `Expense`. Поэтому строка плана
 * не «обновляется» расходом, а сверяется с ним при чтении: правка расхода
 * задним числом сразу видна в бюджете, и пересчитывать нечего.
 *
 * Второе правило вытекает из двухуровневого справочника статей (0030): план
 * по разделу собирает расходы **всех его подкатегорий**. «Налоги» в ТЗ — это
 * свод четырёх налогов, и выделять на них деньги четырьмя строками значило бы
 * отменить причину, по которой справочник сделан двухуровневым.
 *
 * Суммы на входе — в тыйинах (правило 0029), наружу уходят сомони.
 */

/**
 * Потолок длины периода — как у обзора (0030) и графика оттока (0025).
 * Дело не в скорости запроса: план на двадцать лет не является планом,
 * а «прочитать все расходы центра» не должно получаться из пустого запроса.
 */
export const MAX_BUDGET_MONTHS = 60;

export const BUDGET_STATUS_TITLES: Record<BudgetStatus, string> = {
  [BudgetStatus.DRAFT]: 'Черновик',
  [BudgetStatus.ACTIVE]: 'Действует',
  [BudgetStatus.CLOSED]: 'Закрыт',
};

/** Строка плана в том виде, в каком её отдаёт БД. Сумма — в тыйинах. */
export interface BudgetLineFact {
  id: string;
  categoryId: string;
  categoryName: string;
  /** Родитель статьи; `null` — статья верхнего уровня. */
  parent: { id: string; name: string } | null;
  allocatedCents: number;
  note: string | null;
}

/** Сведённая строка плана: сколько выделено, сколько ушло, сколько осталось. */
export interface BudgetLineTotal {
  id: string;
  category: { id: string; name: string };
  categoryParent: { id: string; name: string } | null;
  allocated: number;
  spent: number;
  /** `allocated − spent`. **Отрицательное значение — это перерасход**, и оно
   * законный ответ: план не ограничивает расходы, он с ними сверяется. */
  remaining: number;
  /**
   * Освоение плана в процентах с двумя знаками. У нулевого плана освоения нет
   * (`null`, а не 0 и не бесконечность): делить не на что, а ноль означал бы
   * «не тратили», хотя деньги могли уйти.
   */
  usage: number | null;
  /** Потрачено больше выделенного. Отдельным полем, чтобы экран не считал сам. */
  overspent: boolean;
  note: string | null;
}

/** Итоги плана — одни на весь бюджет (ТЗ 5.16: «allocated/spent»). */
export interface BudgetTotals {
  allocated: number;
  spent: number;
  remaining: number;
  usage: number | null;
  overspent: boolean;
}

/**
 * Строка фонда оплаты труда. Отдельно от `lines`, потому что зарплата
 * не является статьёй расхода (решение 0032): выплата не заводит `Expense`,
 * и планировать её строкой `BudgetCategory` было бы нечем — у той обязательно
 * есть статья.
 */
export interface BudgetSalaryTotal {
  allocated: number;
  spent: number;
  remaining: number;
  usage: number | null;
  overspent: boolean;
}

/** Свод бюджета: строки со `spent`, фонд оплаты труда и итоги по ним. */
export interface BudgetSummary {
  lines: BudgetLineTotal[];
  /** `null` — фонд оплаты труда в этом плане не планировали. */
  salary: BudgetSalaryTotal | null;
  totals: BudgetTotals;
}

/**
 * Сколько потрачено по статье плана: расходы самой статьи **плюс расходы
 * её подкатегорий**.
 *
 * `childrenByParent` приходит снаружи (из справочника), а не выводится
 * из расходов: раздел, по которому в этом периоде не тратили, обязан
 * остаться в плане с нулём, а не пропасть.
 */
export function spentCentsOfCategory(
  categoryId: string,
  spentByCategory: ReadonlyMap<string, number>,
  childrenByParent: ReadonlyMap<string, readonly string[]>,
): number {
  const own = spentByCategory.get(categoryId) ?? 0;
  const children = childrenByParent.get(categoryId) ?? [];

  return children.reduce((sum, childId) => sum + (spentByCategory.get(childId) ?? 0), own);
}

/**
 * Свод плана: строки с `spent` и итоги.
 *
 * Порядок строк — по убыванию выделенного, при равенстве по названию: первым
 * читают самое крупное, а устойчивость нужна, чтобы два вызова с теми же
 * данными давали один ответ (приём 0024, 0025, 0030).
 *
 * Итоговый `spent` складывается из строк, а не из всех расходов периода:
 * расход по незапланированной статье в план не входит — он не «сверх бюджета
 * по этой строке», его строки просто нет. Двойного счёта при этом не возникает,
 * потому что раздел и его подкатегория не встают в один бюджет двумя строками
 * (правило сервиса).
 */
export function summarizeBudget(
  lines: readonly BudgetLineFact[],
  spentByCategory: ReadonlyMap<string, number>,
  childrenByParent: ReadonlyMap<string, readonly string[]>,
  salary?: { allocatedCents: number | null; spentCents: number },
): BudgetSummary {
  const rows = lines.map((line) => {
    const spentCents = spentCentsOfCategory(line.categoryId, spentByCategory, childrenByParent);

    return {
      id: line.id,
      category: { id: line.categoryId, name: line.categoryName },
      categoryParent: line.parent,
      allocated: fromCents(line.allocatedCents),
      spent: fromCents(spentCents),
      // Вычитание идёт в тыйинах и только потом переводится в сомони:
      // разность округлённых сомони разошлась бы со строками на копейки (0030).
      remaining: fromCents(line.allocatedCents - spentCents),
      usage: usageOf(line.allocatedCents, spentCents),
      overspent: spentCents > line.allocatedCents,
      note: line.note,
    };
  });

  rows.sort((a, b) => b.allocated - a.allocated || compareText(a.category.name, b.category.name));

  // Фонд оплаты труда входит в итоги, **только если его планировали**: строки
  // для незапланированного нет, и выдумывать её значило бы утверждать, что
  // на зарплату выделяли (тот же довод, что у расхода по незапланированной
  // статье). Выплаты при этом происходили — их видно в обзоре.
  const salaryLine =
    salary === undefined || salary.allocatedCents === null
      ? null
      : {
          allocated: fromCents(salary.allocatedCents),
          spent: fromCents(salary.spentCents),
          remaining: fromCents(salary.allocatedCents - salary.spentCents),
          usage: usageOf(salary.allocatedCents, salary.spentCents),
          overspent: salary.spentCents > salary.allocatedCents,
        };

  const salaryAllocatedCents = salary?.allocatedCents ?? 0;
  const salarySpentCents = salaryLine === null ? 0 : (salary?.spentCents ?? 0);

  const allocatedCents =
    lines.reduce((sum, line) => sum + line.allocatedCents, 0) + salaryAllocatedCents;
  const spentCents =
    lines.reduce(
      (sum, line) => sum + spentCentsOfCategory(line.categoryId, spentByCategory, childrenByParent),
      0,
    ) + salarySpentCents;

  return {
    lines: rows,
    salary: salaryLine,
    totals: {
      allocated: fromCents(allocatedCents),
      spent: fromCents(spentCents),
      remaining: fromCents(allocatedCents - spentCents),
      usage: usageOf(allocatedCents, spentCents),
      overspent: spentCents > allocatedCents,
    },
  };
}

/**
 * Освоение в процентах с двумя знаками; `null` у нулевого плана.
 *
 * Ноль вместо `null` утверждал бы, что деньги не тратили, — а по статье
 * с нулевым планом вполне могли потратить, и это как раз то, что нужно
 * увидеть. То же соображение, что с `averageScore: null` (0019) и «месяцем
 * без записи об уровне» (0021): пробел должен быть видимым.
 */
export const usageOf = (allocatedCents: number, spentCents: number): number | null =>
  allocatedCents === 0 ? null : Math.round((spentCents / allocatedCents) * 10_000) / 100;

/**
 * Сравнение названий без учёта локали: `localeCompare` зависит от окружения,
 * а порядок внутри одинаковых сумм должен быть одним и тем же везде (0025).
 */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
