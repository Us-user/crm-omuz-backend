import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BudgetStatus } from '@prisma/client';

import type { Paginated } from '../common';
import {
  BusinessRuleException,
  emptyToNullPatch,
  formatIsoMonth,
  monthSequence,
  nextIsoMonth,
  Paginated as PaginatedResult,
  parseIsoMonth,
} from '../common';
import { toCents } from './accounting';
import type { BudgetLineInput, BudgetListParams, BudgetRow } from './accounting.repository';
import { AccountingRepository } from './accounting.repository';
import type { BudgetLineFact, BudgetSummary } from './budget';
import { BUDGET_STATUS_TITLES, MAX_BUDGET_MONTHS, summarizeBudget } from './budget';
import type {
  BudgetCardDto,
  BudgetDeletedDto,
  BudgetDto,
  BudgetLineInputDto,
  BudgetsQueryDto,
  CreateBudgetDto,
  UpdateBudgetDto,
} from './dto';

/**
 * Бюджет центра (ТЗ 5.16: «Budget: план по категориям — allocated/spent,
 * период, статус»).
 *
 * План **ничего не запрещает**: расход сверх выделенного проводится и попадает
 * в отчёт перерасходом. Бюджет — это то, с чем сверяются, а не ограничение,
 * которое отвечает отказом; запрет тратить сверх плана остановил бы оплату
 * налога и был бы правилом, которого ТЗ не задаёт.
 *
 * Отсюда всё остальное:
 *   - `spent` **считается**, а не хранится (см. `budget.ts`): расходы уже
 *     записаны, и вторая копия того же числа разошлась бы с ними при первой
 *     же правке расхода;
 *   - план по разделу собирает расходы **всех его подкатегорий** — ради этого
 *     справочник статей и сделан двухуровневым (0030), — а раздел и его
 *     подкатегория не встают в один бюджет двумя строками (422), иначе один
 *     расход попал бы в обе и сумма строк перестала бы что-либо значить;
 *   - периоды разных бюджетов **пересекаться могут**: годовой план и план
 *     кампании на март — законная пара, каждый считает своё окно.
 *
 * Статусы — `DRAFT → ACTIVE → CLOSED` (решение пользователя, 0031). Закрытый
 * план не правится: это снимок принятого решения, как финализированная неделя
 * журнала (0018) и закрытый месяц рейтинга (0024). Единственное, что у него
 * принимается, — возврат в `ACTIVE`: без него ошибочное закрытие было бы
 * необратимым, а обратимость ошибочного действия в проекте закрывается
 * не отсутствием запрета, а явным обратным ходом (0021, 0022, 0024, 0026).
 */
@Injectable()
export class BudgetService {
  private readonly logger = new Logger(BudgetService.name);

  constructor(private readonly repository: AccountingRepository) {}

  async findAll(query: BudgetsQueryDto): Promise<Paginated<BudgetDto>> {
    const params: BudgetListParams = {
      status: query.status,
      categoryId: query.categoryId,
      from: query.from === undefined ? undefined : parseIsoMonth(query.from, 'from'),
      to: query.to === undefined ? undefined : parseIsoMonth(query.to, 'to'),
      search: query.search,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    };

    const { rows, total } = await this.repository.findManyBudgets(params);
    const summaries = await this.summarizeAll(rows);

    return PaginatedResult.from(
      rows.map((row) => toRowDto(row, summaryOf(summaries, row))),
      total,
      query,
    );
  }

  async findOne(id: string): Promise<BudgetCardDto> {
    const budget = await this.require(id);
    const summaries = await this.summarizeAll([budget]);

    return toCardDto(budget, summaryOf(summaries, budget));
  }

  async create(dto: CreateBudgetDto, accountId: string): Promise<BudgetCardDto> {
    await this.assertNameFree(dto.name);

    const periodFrom = parseIsoMonth(dto.periodFrom, 'periodFrom');
    const periodTo = parseIsoMonth(dto.periodTo, 'periodTo');
    assertPeriod(periodFrom, periodTo);

    const budget = await this.repository.createBudget({
      name: dto.name,
      description:
        dto.description === undefined ? null : (emptyToNullPatch(dto.description) ?? null),
      periodFrom,
      periodTo,
      status: dto.status,
      salaryAllocatedCents:
        dto.salaryAllocated === undefined || dto.salaryAllocated === null
          ? null
          : toCents(dto.salaryAllocated),
      lines: await this.resolveLines(dto.lines ?? []),
      createdById: await this.employeeIdOf(accountId),
    });

    this.logger.log(
      `Заведён бюджет «${budget.name}» на ${formatIsoMonth(periodFrom)}…` +
        `${formatIsoMonth(periodTo)} (${budget.id})`,
    );

    return this.findOne(budget.id);
  }

  async update(id: string, dto: UpdateBudgetDto): Promise<BudgetCardDto> {
    const existing = await this.require(id);

    this.assertEditable(existing, dto);

    if (dto.name !== undefined && dto.name.toLowerCase() !== existing.name.toLowerCase()) {
      await this.assertNameFree(dto.name);
    }

    // Период сверяется по **итоговому** состоянию: передать можно один конец,
    // и сравнивать его с пустотой значило бы пропускать «поставили конец раньше
    // существующего начала» (приём сессий 0008, 0011, 0018).
    const periodFrom =
      dto.periodFrom === undefined
        ? existing.periodFrom
        : parseIsoMonth(dto.periodFrom, 'periodFrom');
    const periodTo =
      dto.periodTo === undefined ? existing.periodTo : parseIsoMonth(dto.periodTo, 'periodTo');
    assertPeriod(periodFrom, periodTo);

    const budget = await this.repository.updateBudget(id, {
      name: dto.name,
      description: emptyToNullPatch(dto.description),
      periodFrom: dto.periodFrom === undefined ? undefined : periodFrom,
      periodTo: dto.periodTo === undefined ? undefined : periodTo,
      status: dto.status,
      // `null` в теле снимает план фонда оплаты труда — тогда он перестаёт
      // входить в итоги (правило «незапланированное в план не попадает»).
      salaryAllocatedCents:
        dto.salaryAllocated === undefined
          ? undefined
          : dto.salaryAllocated === null
            ? null
            : toCents(dto.salaryAllocated),
      lines: dto.lines === undefined ? undefined : await this.resolveLines(dto.lines),
    });

    this.logger.log(`Изменён бюджет «${budget.name}» (${id})`);

    return this.findOne(budget.id);
  }

  /**
   * Удаление плана — сверх перечня маршрутов ТЗ 5.16 (там `GET/POST/PUT`).
   * Девятый раз тот же ход (0009, 0010, 0012, 0015, 0021, 0022, 0024, 0026,
   * 0029): без него ошибочно заведённый план остался бы в отчётах навсегда.
   *
   * Причина при этом не требуется — в отличие от удаления расхода (0030):
   * там исчезает запись о **деньгах**, здесь — намерение их потратить.
   * Закрытый план не удаляется: сначала верните его в работу.
   */
  async remove(id: string): Promise<BudgetDeletedDto> {
    const budget = await this.require(id);

    if (budget.status === BudgetStatus.CLOSED) {
      throw new BusinessRuleException(
        'Закрытый бюджет не удаляется: это снимок принятого решения. ' +
          'Верните его в статус ACTIVE, если удаление действительно нужно',
        { status: budget.status },
      );
    }

    await this.repository.deleteBudget(id);
    this.logger.log(`Удалён бюджет «${budget.name}» (${id})`);

    return { id, name: budget.name };
  }

  /**
   * Свод сразу по нескольким планам.
   *
   * Расходы читаются **одним запросом на каждое различное окно периода**,
   * а не на каждый бюджет: планы центра обычно делят период (квартал, год),
   * поэтому на странице оказывается одно-два окна. Отбор дополнительно сужен
   * статьями плана, так что запрос ложится на индекс `(categoryId, spentAt)`.
   */
  private async summarizeAll(rows: BudgetRow[]): Promise<Map<string, BudgetSummary>> {
    const summaries = new Map<string, BudgetSummary>();
    if (rows.length === 0) return summaries;

    // Родство статей нужно один раз на всю страницу — план по разделу
    // собирает расходы его подкатегорий.
    const plannedIds = [
      ...new Set(rows.flatMap((row) => row.lines.map((line) => line.category.id))),
    ];
    const childrenByParent = await this.repository.findChildIdsByParents(plannedIds);

    for (const window of windowsOf(rows)) {
      // Освоение фонда оплаты труда считается по выплатам того же окна — так же,
      // как `spent` статьи считается по расходам: зарплата не заводит `Expense`
      // (решение 0032), поэтому у неё свой источник, а не своя строка расхода.
      const salarySpentCents = window.budgets.some((row) => row.salaryAllocated !== null)
        ? await this.repository.sumSalaryPaid(window.from, nextIsoMonth(window.to))
        : 0;

      const categoryIds = [
        ...new Set(
          window.budgets.flatMap((row) =>
            row.lines.flatMap((line) => [
              line.category.id,
              ...(childrenByParent.get(line.category.id) ?? []),
            ]),
          ),
        ),
      ];

      const spentByCategory = await this.repository.findExpenseTotalsByCategory(
        window.from,
        // Правая граница периода включающая, поэтому в запрос уходит первое
        // число следующего месяца: считать последний день значило бы выводить
        // самому, сколько их в месяце (приём 0025).
        nextIsoMonth(window.to),
        categoryIds,
      );

      for (const row of window.budgets) {
        summaries.set(
          row.id,
          summarizeBudget(linesOf(row), spentByCategory, childrenByParent, {
            allocatedCents: row.salaryAllocated === null ? null : toCents(row.salaryAllocated),
            spentCents: salarySpentCents,
          }),
        );
      }
    }

    return summaries;
  }

  /**
   * Разбор строк плана: статьи должны существовать, быть действующими
   * и не пересекаться по родству.
   *
   * Повтор статьи в запросе — 400 (ошибка формы, как повтор в мультивыборе
   * силлабуса, 0009), несуществующая и выведенная — 422 (ресурс из пути найден,
   * не найдено то, что пришло в теле: правило сессий 0006–0009). В `details`
   * уходят **только проблемные** идентификаторы, а не весь список.
   */
  private async resolveLines(inputs: BudgetLineInputDto[]): Promise<BudgetLineInput[]> {
    const ids = inputs.map((line) => line.categoryId);

    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    if (duplicates.length > 0) {
      throw new BadRequestException({
        message: 'Статья указана в плане дважды',
        details: { categoryIds: duplicates },
      });
    }

    const categories = await this.repository.findCategoriesByIds([...new Set(ids)]);
    const byId = new Map(categories.map((category) => [category.id, category]));

    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new BusinessRuleException('Категории расхода не найдены', { categoryIds: missing });
    }

    const inactive = categories.filter((category) => category.status === 'INACTIVE');
    if (inactive.length > 0) {
      throw new BusinessRuleException(
        `Категории выведены из работы: ${inactive.map((c) => `«${c.name}»`).join(', ')} — ` +
          'планировать по ним нельзя',
        { categoryIds: inactive.map((c) => c.id) },
      );
    }

    // Раздел и его подкатегория в одном плане дали бы двойной счёт: расход
    // по НДС попал бы и в строку «НДС», и в строку «Налоги».
    const planned = new Set(ids);
    const clash = categories.find(
      (category) => category.parentId !== null && planned.has(category.parentId),
    );
    if (clash) {
      const parent = byId.get(clash.parentId ?? '');

      throw new BusinessRuleException(
        `Статья «${clash.name}» входит в раздел «${parent?.name ?? '—'}», который уже ` +
          'запланирован в этом бюджете: расход по ней попал бы в обе строки. ' +
          'Оставьте либо раздел, либо его статьи',
        { categoryIds: [clash.id, clash.parentId] },
      );
    }

    return inputs.map((line) => ({
      categoryId: line.categoryId,
      allocatedCents: toCents(line.allocated),
      note: line.note === undefined ? null : (emptyToNullPatch(line.note) ?? null),
    }));
  }

  /**
   * Закрытый план не правится — кроме возврата в работу. Проверяется
   * **намерение** запроса, а не его результат: `{ status: ACTIVE }` проходит,
   * `{ status: ACTIVE, name: … }` — нет, иначе правка проезжала бы «заодно»
   * с открытием.
   */
  private assertEditable(existing: BudgetRow, dto: UpdateBudgetDto): void {
    if (existing.status !== BudgetStatus.CLOSED) return;

    const onlyReopen =
      dto.status === BudgetStatus.ACTIVE &&
      Object.keys(dto).every(
        (key) => key === 'status' || dto[key as keyof UpdateBudgetDto] === undefined,
      );

    if (!onlyReopen) {
      throw new BusinessRuleException(
        'Закрытый бюджет не правится: это снимок принятого решения. ' +
          'Верните его в статус ACTIVE отдельным запросом, если план нужно изменить',
        { status: existing.status },
      );
    }
  }

  private async require(id: string): Promise<BudgetRow> {
    const budget = await this.repository.findBudgetById(id);
    if (!budget) {
      throw new NotFoundException('Бюджет не найден');
    }

    return budget;
  }

  private async assertNameFree(name: string): Promise<void> {
    const twin = await this.repository.findBudgetByName(name);
    if (twin) {
      throw new ConflictException(`Бюджет «${twin.name}» уже заведён`);
    }
  }

  private async employeeIdOf(accountId: string): Promise<string | null> {
    const employee = await this.repository.findEmployeeByAccount(accountId);

    return employee?.id ?? null;
  }
}

/** Планы, сгруппированные по одинаковому периоду. */
const windowsOf = (rows: BudgetRow[]): { from: Date; to: Date; budgets: BudgetRow[] }[] => {
  const windows = new Map<string, { from: Date; to: Date; budgets: BudgetRow[] }>();

  for (const row of rows) {
    const key = `${row.periodFrom.toISOString()}|${row.periodTo.toISOString()}`;
    const window = windows.get(key) ?? { from: row.periodFrom, to: row.periodTo, budgets: [] };
    window.budgets.push(row);
    windows.set(key, window);
  }

  return [...windows.values()];
};

/**
 * Период не может кончаться раньше, чем начинается, и не бывает длиннее
 * потолка. Оба — 400: это противоречие внутри самого запроса, а не нарушение
 * правила предметной области (приём сессии 0008).
 */
const assertPeriod = (from: Date, to: Date): void => {
  if (to.getTime() < from.getTime()) {
    throw new BadRequestException({
      message: 'Период бюджета задан наоборот',
      details: { periodTo: 'Конец периода не может быть раньше начала' },
    });
  }

  const months = monthSequence(from, to).length;
  if (months > MAX_BUDGET_MONTHS) {
    throw new BadRequestException({
      message: 'Период бюджета слишком длинный',
      details: {
        periodTo: `Максимум ${String(MAX_BUDGET_MONTHS)} месяцев, запрошено ${String(months)}`,
      },
    });
  }
};

const linesOf = (row: BudgetRow): BudgetLineFact[] =>
  row.lines.map((line) => ({
    id: line.id,
    categoryId: line.category.id,
    categoryName: line.category.name,
    parent: line.category.parent,
    allocatedCents: toCents(line.allocated),
    note: line.note,
  }));

/** Пустой свод для плана без строк — считать по нему нечего. */
const EMPTY_SUMMARY: BudgetSummary = {
  lines: [],
  salary: null,
  totals: { allocated: 0, spent: 0, remaining: 0, usage: null, overspent: false },
};

const summaryOf = (summaries: Map<string, BudgetSummary>, row: BudgetRow): BudgetSummary =>
  summaries.get(row.id) ?? EMPTY_SUMMARY;

const toRowDto = (row: BudgetRow, summary: BudgetSummary): BudgetDto => ({
  id: row.id,
  name: row.name,
  description: row.description,
  periodFrom: formatIsoMonth(row.periodFrom),
  periodTo: formatIsoMonth(row.periodTo),
  status: row.status,
  statusTitle: BUDGET_STATUS_TITLES[row.status],
  linesCount: row.lines.length,
  salary: summary.salary,
  totals: summary.totals,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});

const toCardDto = (row: BudgetRow, summary: BudgetSummary): BudgetCardDto => ({
  ...toRowDto(row, summary),
  lines: summary.lines,
});
