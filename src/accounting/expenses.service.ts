import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import type { Paginated } from '../common';
import {
  BusinessRuleException,
  emptyToNullPatch,
  formatIsoDate,
  nextIsoMonth,
  Paginated as PaginatedResult,
  parseIsoDate,
  parseIsoMonth,
} from '../common';
import { fromCents, toCents } from './accounting';
import type { ExpenseFilter, ExpenseRow } from './accounting.repository';
import { AccountingRepository } from './accounting.repository';
import type {
  CreateExpenseDto,
  ExpenseDeletedDto,
  ExpenseDto,
  ExpensesQueryDto,
  ReasonDto,
  UpdateExpenseDto,
} from './dto';

/**
 * Расходы центра (ТЗ 5.16: «Expenses»).
 *
 * Расход устроен проще начисления студенту (0029): он либо проведён, либо нет,
 * поэтому ни статуса, ни остатка здесь не появляется — закрывать его нечем.
 * Общее с кассой одно, зато главное: **все расчёты идут в тыйинах**, а суммы
 * уходят в БД строкой (правило 0029) — из этих строк складывается
 * «Income vs Expense» обзора.
 *
 * Обобщённый `Transaction` из карты сущностей ТЗ 4 не заводится: приход уже
 * описан `PaymentTransaction`, и общая таблица на два потока потребовала бы
 * колонки-дискриминатора и половины полей, пустых по определению. Сводит
 * потоки обзор, а не схема.
 */
@Injectable()
export class ExpensesService {
  private readonly logger = new Logger(ExpensesService.name);

  constructor(private readonly repository: AccountingRepository) {}

  async findAll(query: ExpensesQueryDto): Promise<Paginated<ExpenseDto>> {
    const filter = await this.filterOf(query);

    const { rows, total, sumCents } = await this.repository.findManyExpenses({
      ...filter,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    // Сумма набора одна на все страницы, поэтому уходит в `meta` — как баланс
    // коинов (0018) и итоги оплат (0029).
    return PaginatedResult.from(rows.map(toDto), total, query, {
      totals: { amount: fromCents(sumCents) },
    });
  }

  async findOne(id: string): Promise<ExpenseDto> {
    return toDto(await this.require(id));
  }

  async create(dto: CreateExpenseDto, accountId: string): Promise<ExpenseDto> {
    const expense = await this.repository.createExpense({
      categoryId: await this.resolveCategory(dto.categoryId),
      title: dto.title,
      amountCents: toCents(dto.amount),
      spentAt: dto.spentAt === undefined ? today() : parseIsoDate(dto.spentAt, 'spentAt'),
      branchId: dto.branchId === undefined ? null : await this.resolveBranch(dto.branchId),
      note: dto.note === undefined ? null : (emptyToNullPatch(dto.note) ?? null),
      createdById: await this.employeeIdOf(accountId),
    });

    this.logger.log(
      `Проведён расход ${String(dto.amount)} TJS: ${expenseTitle(expense)} (${expense.id})`,
    );

    return toDto(expense);
  }

  async update(id: string, dto: UpdateExpenseDto): Promise<ExpenseDto> {
    const existing = await this.require(id);

    // Пустая строка снимает привязку к филиалу — расход становится общим
    // для центра (правило пустой строки, 0011, 0014, 0029).
    const branchId = dto.branchId === undefined ? undefined : emptyToNullPatch(dto.branchId);

    const expense = await this.repository.updateExpense(id, {
      categoryId:
        dto.categoryId === undefined ? undefined : await this.resolveCategory(dto.categoryId),
      title: dto.title,
      amountCents: dto.amount === undefined ? undefined : toCents(dto.amount),
      spentAt: dto.spentAt === undefined ? undefined : parseIsoDate(dto.spentAt, 'spentAt'),
      branchId:
        branchId === undefined || branchId === null ? branchId : await this.resolveBranch(branchId),
      note: emptyToNullPatch(dto.note),
    });

    this.logger.log(`Изменён расход ${expenseTitle(existing)} (${id})`);

    return toDto(expense);
  }

  /**
   * Удаление расхода — с обязательной причиной, как отмена платежа (0029):
   * строка про деньги не должна исчезать бесследно. Причина уходит в лог,
   * а с Фазой 13 — в `AuditLog`.
   */
  async remove(id: string, dto: ReasonDto): Promise<ExpenseDeletedDto> {
    const expense = await this.require(id);

    await this.repository.deleteExpense(id);
    this.logger.log(`Удалён расход ${expenseTitle(expense)} (${id}): ${dto.reason}`);

    return { id, title: expenseTitle(expense) };
  }

  /**
   * Разбор фильтров списка. Категория верхнего уровня отбирает **и свои
   * подкатегории**: «сколько ушло на налоги» — тот самый вопрос, ради которого
   * справочник сделан двухуровневым, и отвечать на него сложением четырёх
   * запросов не должно требоваться.
   */
  private async filterOf(query: ExpensesQueryDto): Promise<ExpenseFilter> {
    return {
      categoryIds:
        query.categoryId === undefined
          ? undefined
          : [query.categoryId, ...(await this.repository.findChildCategoryIds(query.categoryId))],
      branchId: query.branchId,
      from: query.from === undefined ? undefined : parseIsoMonth(query.from, 'from'),
      to: query.to === undefined ? undefined : nextIsoMonth(parseIsoMonth(query.to, 'to')),
      search: query.search,
    };
  }

  /**
   * Статья расхода из справочника. Выведенная из работы (`INACTIVE`) новым
   * расходам не проставляется — та же асимметрия, что у способа оплаты (0029)
   * и ступени ментора (0021): уже проведённые расходы её не теряют.
   */
  private async resolveCategory(categoryId: string): Promise<string> {
    const category = await this.repository.findCategoryById(categoryId);
    if (category === null) {
      throw new BusinessRuleException('Категория расхода не найдена', { categoryId });
    }

    if (category.status === 'INACTIVE') {
      throw new BusinessRuleException(
        `Категория «${category.name}» выведена из работы — выберите действующую`,
        { categoryId },
      );
    }

    return category.id;
  }

  private async resolveBranch(branchId: string): Promise<string> {
    const branch = await this.repository.findBranchById(branchId);
    if (branch === null) {
      throw new BusinessRuleException('Филиал не найден', { branchId });
    }

    return branch.id;
  }

  private async require(id: string): Promise<ExpenseRow> {
    const expense = await this.repository.findExpenseById(id);
    if (!expense) {
      throw new NotFoundException('Расход не найден');
    }

    return expense;
  }

  private async employeeIdOf(accountId: string): Promise<string | null> {
    const employee = await this.repository.findEmployeeByAccount(accountId);

    return employee?.id ?? null;
  }
}

/**
 * Полночь сегодняшнего дня по UTC: колонка `spentAt` объявлена `@db.Date`,
 * времени в ней нет (приём 0021, 0023, 0026, 0029).
 */
const today = (): Date => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

const expenseTitle = (expense: ExpenseRow): string =>
  `${expense.title}, ${String(Number(expense.amount))} TJS от ${formatIsoDate(expense.spentAt)}`;

const toDto = (row: ExpenseRow): ExpenseDto => ({
  id: row.id,
  category: { id: row.category.id, name: row.category.name },
  categoryParent: row.category.parent,
  title: row.title,
  amount: Number(row.amount),
  spentAt: formatIsoDate(row.spentAt),
  branch: row.branch,
  note: row.note,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});
