import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  AccountingPeriodStatus,
  AccountType,
  BudgetStatus,
  DirectoryStatus,
  GroupStatus,
  Prisma,
  SalaryStatus,
  StudentStatus,
} from '@prisma/client';
import request from 'supertest';

import { AccountingModule } from 'src/accounting/accounting.module';
import { ChargeStatus } from 'src/accounting/accounting';
import type {
  AccountingPeriodCloseInput,
  AccountingPeriodCreateInput,
  AccountingPeriodListParams,
  AccountingPeriodRow,
  AccountingPeriodUpdateInput,
  BudgetCreateInput,
  BudgetListParams,
  BudgetRow,
  BudgetUpdateInput,
  ChargeFilter,
  ChargeInput,
  ChargeListParams,
  ChargeRow,
  ChargeUpdateInput,
  ExpenseCategoryRow,
  ExpenseCategoryWriteInput,
  ExpenseFilter,
  ExpenseInput,
  ExpenseListParams,
  ExpenseRow,
  ExpenseUpdateInput,
  MonthLevel,
  PaymentTypeListParams,
  PaymentTypeRow,
  PaymentTypeWriteInput,
  SalaryConfirmInput,
  SalaryFilter,
  SalaryListParams,
  SalaryRow,
  SalaryTransactionInput,
  SalaryTransactionRow,
  SalaryUpdateInput,
  StudentProfile,
  TransactionInput,
  TransactionListParams,
  TransactionRow,
  TransactionUpdateInput,
} from 'src/accounting/accounting.repository';
import { AccountingRepository } from 'src/accounting/accounting.repository';
import type {
  CategoryNode,
  ExpenseFact,
  GroupChargeFact,
  GroupRef,
  MoneyFact,
} from 'src/accounting/overview';
import { AccountingPeriodSortField, SalarySortField } from 'src/accounting/dto';
import type { PeriodFacts } from 'src/accounting/periods';
import type { SalaryDayFact } from 'src/accounting/salary';
import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, SortOrder, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { PhoneModule } from 'src/phone/phone.module';
import { RbacModule } from 'src/rbac/rbac.module';
import { RbacRepository } from 'src/rbac/rbac.repository';
import { buildOpenApiDocument } from 'src/swagger';

/** `{ data }` / `{ meta }` ответа с ожидаемым типом — тела supertest это `any`. */
const dataOf = <T>(response: { body: unknown }): T => (response.body as { data: T }).data;
const metaOf = <T>(response: { body: unknown }): T => (response.body as { meta: T }).meta;

/** Права аккаунта в памяти вместо трёх таблиц RBAC (как в остальных наборах). */
class InMemoryRbacRepository {
  private readonly codesByAccount = new Map<string, string[]>();

  grant(accountId: string, codes: string[]): void {
    this.codesByAccount.set(accountId, codes);
  }

  findAccountPermissionCodes(accountId: string): Promise<{ code: string }[]> {
    return Promise.resolve((this.codesByAccount.get(accountId) ?? []).map((code) => ({ code })));
  }

  findAllPermissions(): Promise<[]> {
    return Promise.resolve([]);
  }

  createPermissions(): Promise<number> {
    return Promise.resolve(0);
  }

  updatePermission(): Promise<void> {
    return Promise.resolve();
  }

  syncSystemPosition(): Promise<number> {
    return Promise.resolve(0);
  }
}

interface StoredStudent {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  status: StudentStatus;
  branchId: string;
}

interface StoredGroup {
  id: string;
  name: string;
  status: GroupStatus;
  courseId: string;
  courseTitle: string;
  branchId: string;
  feeCents: number;
  members: string[];
}

interface StoredCharge {
  id: string;
  studentId: string;
  groupId: string;
  month: Date;
  amountCents: number;
  discountCents: number;
  discountReason: string | null;
  paidCents: number;
  remainingCents: number;
  note: string | null;
  createdAt: Date;
}

interface StoredTransaction {
  id: string;
  studentId: string;
  chargeId: string | null;
  amountCents: number;
  paidAt: Date;
  typeId: string | null;
  comment: string | null;
  editReason: string | null;
  editedAt: Date | null;
  createdAt: Date;
}

interface StoredType {
  id: string;
  name: string;
  description: string | null;
  status: DirectoryStatus;
  createdAt: Date;
}

interface StoredCategory {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  status: DirectoryStatus;
  createdAt: Date;
}

interface StoredExpense {
  id: string;
  categoryId: string;
  title: string;
  amountCents: number;
  spentAt: Date;
  branchId: string | null;
  note: string | null;
  createdAt: Date;
}

interface StoredBudgetLine {
  id: string;
  categoryId: string;
  allocatedCents: number;
  note: string | null;
}

interface StoredBudget {
  id: string;
  name: string;
  description: string | null;
  periodFrom: Date;
  periodTo: Date;
  status: BudgetStatus;
  /** Фонд оплаты труда; `null` — не планировали (0032). */
  salaryAllocatedCents: number | null;
  lines: StoredBudgetLine[];
  createdAt: Date;
}

/** Профиль сотрудника — строка ведомости зарплат подписывается им. */
interface StoredEmployeeProfile {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  branchId: string | null;
  status: string;
}

/**
 * Учебный день журнала: **источник часов зарплаты** (ТЗ 5.16, решение 0032).
 * Хранилище держит его здесь, потому что ведомость обязана считаться по тем же
 * дням, которые видит журнал, — иначе тест проверял бы согласованность двух
 * наборов чисел, а не поведение модуля.
 */
interface StoredTaughtDay {
  mentorId: string;
  date: Date;
  minutes: number | null;
  groupId: string | null;
}

/** Уровень ментора в месяце — из него берётся часовая ставка (0021). */
interface StoredMonthLevel {
  employeeId: string;
  month: Date;
  levelId: string;
  levelName: string;
  hourlyRateCents: number;
}

/** Одобренная заявка на аванс — «Prepaid» месяца (0022, 0031). */
interface StoredApprovedAvans {
  employeeId: string;
  month: Date;
  amountCents: number;
}

interface StoredSalary {
  id: string;
  employeeId: string;
  month: Date;
  bonusCents: number;
  note: string | null;
  status: SalaryStatus;
  minutes: number | null;
  hourlyRateCents: number | null;
  totalCents: number | null;
  confirmedAt: Date | null;
  confirmedById: string | null;
  createdById: string | null;
  createdAt: Date;
}

/** Финансовый период-отчёт: границы, состояние и снимок (0033). */
interface StoredPeriod {
  id: string;
  name: string;
  description: string | null;
  periodFrom: Date;
  periodTo: Date;
  status: AccountingPeriodStatus;
  /** `null` — период в работе, снимка нет. */
  snapshot: PeriodFacts | null;
  closedAt: Date | null;
  createdAt: Date;
}

interface StoredSalaryTransaction {
  id: string;
  salaryId: string;
  amountCents: number;
  paidAt: Date;
  typeId: string;
  comment: string | null;
  createdAt: Date;
}

const money = (cents: number): string => (cents / 100).toFixed(2);

/**
 * Хранилище платёжного контура в памяти.
 *
 * Оно **повторяет правила репозитория**, а не подставляет готовые числа:
 * начисление идемпотентно по ключу «студент + группа + месяц», а принятая
 * сумма и остаток месяца пересчитываются после каждой записи платежа — ровно
 * то, что в БД делает `recalcCharge` внутри транзакции. Иначе тесты проверяли
 * бы согласованность двух наборов чисел в самом хранилище, а не поведение
 * модуля (приём сессий 0019, 0025, 0027).
 */
class InMemoryStore {
  private readonly students = new Map<string, StoredStudent>();
  private readonly groups = new Map<string, StoredGroup>();
  private readonly charges = new Map<string, StoredCharge>();
  private readonly transactions = new Map<string, StoredTransaction>();
  private readonly types = new Map<string, StoredType>();
  private readonly categories = new Map<string, StoredCategory>();
  private readonly expenses = new Map<string, StoredExpense>();
  private readonly budgets = new Map<string, StoredBudget>();
  private readonly branches = new Map<string, string>([['branch-1', 'Sadbarg']]);
  private readonly employees = new Map<string, string>();
  private readonly employeeProfiles = new Map<string, StoredEmployeeProfile>();
  private readonly taughtDays: StoredTaughtDay[] = [];
  private readonly monthLevels: StoredMonthLevel[] = [];
  private readonly approvedAvans: StoredApprovedAvans[] = [];
  private readonly salaries = new Map<string, StoredSalary>();
  private readonly salaryTransactions = new Map<string, StoredSalaryTransaction>();
  private readonly periods = new Map<string, StoredPeriod>();

  // ─────────────────────────── Засев данных ────────────────────────────────

  addStudent(overrides: Partial<StoredStudent> = {}): string {
    const id = overrides.id ?? randomUUID();
    this.students.set(id, {
      firstName: 'Нилуфар',
      lastName: 'Каримова',
      phone: `+99290${String(this.students.size).padStart(7, '0')}`,
      status: StudentStatus.ACTIVE,
      branchId: 'branch-1',
      ...overrides,
      id,
    });

    return id;
  }

  addGroup(overrides: Partial<StoredGroup> = {}): string {
    const id = overrides.id ?? randomUUID();
    this.groups.set(id, {
      name: 'Frontend-1',
      status: GroupStatus.ACTIVE,
      courseId: randomUUID(),
      courseTitle: 'Frontend Pro',
      branchId: 'branch-1',
      feeCents: 120000,
      members: [],
      ...overrides,
      id,
    });

    return id;
  }

  enroll(groupId: string, studentId: string): void {
    this.groups.get(groupId)?.members.push(studentId);
  }

  addEmployee(accountId: string): string {
    const id = randomUUID();
    this.employees.set(accountId, id);
    this.employeeProfiles.set(id, {
      id,
      firstName: 'Аниса',
      lastName: 'Рахматова',
      phone: `+99298${String(this.employeeProfiles.size).padStart(7, '0')}`,
      branchId: 'branch-1',
      status: 'ACTIVE',
    });

    return id;
  }

  /** Профиль сотрудника без аккаунта — тот, кому считают зарплату. */
  seedEmployee(overrides: Partial<StoredEmployeeProfile> = {}): string {
    const id = overrides.id ?? randomUUID();
    this.employeeProfiles.set(id, {
      firstName: 'Фаррух',
      lastName: 'Раҳимов',
      phone: `+99290${String(this.employeeProfiles.size).padStart(7, '0')}`,
      branchId: 'branch-1',
      status: 'ACTIVE',
      ...overrides,
      id,
    });

    return id;
  }

  /** Проведённое занятие в журнале — из него складываются часы месяца. */
  seedTaughtDay(mentorId: string, iso: string, minutes: number | null, groupId?: string): void {
    this.taughtDays.push({
      mentorId,
      date: new Date(`${iso}T00:00:00.000Z`),
      minutes,
      groupId: groupId ?? null,
    });
  }

  /** Уровень ментора на месяц: месяца без записи не бывает «по умолчанию» (0021). */
  seedMonthLevel(employeeId: string, month: string, hourlyRate: number, name = 'Senior'): string {
    const levelId = randomUUID();
    this.monthLevels.push({
      employeeId,
      month: new Date(`${month}-01T00:00:00.000Z`),
      levelId,
      levelName: name,
      hourlyRateCents: Math.round(hourlyRate * 100),
    });

    return levelId;
  }

  seedApprovedAvans(employeeId: string, month: string, amount: number): void {
    this.approvedAvans.push({
      employeeId,
      month: new Date(`${month}-01T00:00:00.000Z`),
      amountCents: Math.round(amount * 100),
    });
  }

  salaryCount(): number {
    return this.salaries.size;
  }

  salaryTransactionCount(): number {
    return this.salaryTransactions.size;
  }

  storedSalaryStatus(id: string): SalaryStatus | undefined {
    return this.salaries.get(id)?.status;
  }

  /** Замороженный итог: им проверяется, что снимок не пересчитывается. */
  storedSalaryTotal(id: string): number | null {
    const total = this.salaries.get(id)?.totalCents;

    return total === null || total === undefined ? null : total / 100;
  }

  seedType(overrides: Partial<StoredType> = {}): string {
    const id = overrides.id ?? randomUUID();
    this.types.set(id, {
      name: 'Alif',
      description: null,
      status: DirectoryStatus.ACTIVE,
      createdAt: new Date(),
      ...overrides,
      id,
    });

    return id;
  }

  /** Филиал с настоящим UUID: `branchId` расхода проверяется `ParseUUID`-правилом DTO. */
  seedBranch(name = 'Profsous'): string {
    const id = randomUUID();
    this.branches.set(id, name);

    return id;
  }

  /** Категория расхода. Без `parentId` — верхнего уровня, как в сиде миграции. */
  seedCategory(overrides: Partial<StoredCategory> = {}): string {
    const id = overrides.id ?? randomUUID();
    this.categories.set(id, {
      name: 'Офис',
      description: null,
      parentId: null,
      status: DirectoryStatus.ACTIVE,
      createdAt: new Date(),
      ...overrides,
      id,
    });

    return id;
  }

  chargeCount(): number {
    return this.charges.size;
  }

  expenseCount(): number {
    return this.expenses.size;
  }

  budgetCount(): number {
    return this.budgets.size;
  }

  /** Строк плана в бюджете — ими проверяется замена набора целиком. */
  budgetLineCount(budgetId: string): number {
    return this.budgets.get(budgetId)?.lines.length ?? 0;
  }

  transactionCount(): number {
    return this.transactions.size;
  }

  storedRemaining(chargeId: string): number {
    return (this.charges.get(chargeId)?.remainingCents ?? 0) / 100;
  }

  // ──────────────────── Справочник способов оплаты ─────────────────────────

  findManyTypes(params: PaymentTypeListParams): Promise<{ rows: PaymentTypeRow[]; total: number }> {
    const rows = [...this.types.values()]
      .filter((type) => params.status === undefined || type.status === params.status)
      .filter(
        (type) =>
          params.search === undefined ||
          type.name.toLowerCase().includes(params.search.toLowerCase()),
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    return Promise.resolve({
      rows: rows.slice(params.skip, params.skip + params.take).map((type) => this.typeRow(type)),
      total: rows.length,
    });
  }

  findTypeById(id: string): Promise<PaymentTypeRow | null> {
    const type = this.types.get(id);

    return Promise.resolve(type ? this.typeRow(type) : null);
  }

  findTypeByName(name: string): Promise<{ id: string; name: string } | null> {
    const type = [...this.types.values()].find(
      (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
    );

    return Promise.resolve(type ? { id: type.id, name: type.name } : null);
  }

  createType(input: PaymentTypeWriteInput & { name: string }): Promise<PaymentTypeRow> {
    const id = this.seedType({
      name: input.name,
      description: input.description ?? null,
      status: input.status ?? DirectoryStatus.ACTIVE,
    });

    return this.findTypeById(id) as Promise<PaymentTypeRow>;
  }

  updateType(id: string, input: PaymentTypeWriteInput): Promise<PaymentTypeRow> {
    const type = this.types.get(id);
    if (!type) throw new Error('type not found');

    if (input.name !== undefined) type.name = input.name;
    if (input.description !== undefined) type.description = input.description;
    if (input.status !== undefined) type.status = input.status;

    return this.findTypeById(id) as Promise<PaymentTypeRow>;
  }

  deleteType(id: string): Promise<void> {
    this.types.delete(id);

    return Promise.resolve();
  }

  private typeRow(type: StoredType): PaymentTypeRow {
    return {
      id: type.id,
      name: type.name,
      description: type.description,
      status: type.status,
      createdAt: type.createdAt,
      _count: {
        transactions: [...this.transactions.values()].filter(
          (transaction) => transaction.typeId === type.id,
        ).length,
        salaryTransactions: [...this.salaryTransactions.values()].filter(
          (payment) => payment.typeId === type.id,
        ).length,
      },
    };
  }

  // ────────────────────────────── Начисления ───────────────────────────────

  findManyCharges(params: ChargeListParams): Promise<{ rows: ChargeRow[]; total: number }> {
    const rows = this.matchCharges(params).sort(
      (a, b) => b.month.getTime() - a.month.getTime() || a.id.localeCompare(b.id),
    );

    return Promise.resolve({
      rows: rows.slice(params.skip, params.skip + params.take).map((row) => this.chargeRow(row)),
      total: rows.length,
    });
  }

  aggregateCharges(filter: ChargeFilter): Promise<{ chargedCents: number; paidCents: number }> {
    const rows = this.matchCharges(filter);

    return Promise.resolve({
      chargedCents: rows.reduce(
        (sum, row) => sum + Math.max(0, row.amountCents - row.discountCents),
        0,
      ),
      paidCents: rows.reduce((sum, row) => sum + row.paidCents, 0),
    });
  }

  findChargeById(id: string): Promise<ChargeRow | null> {
    const charge = this.charges.get(id);

    return Promise.resolve(charge ? this.chargeRow(charge) : null);
  }

  findChargeCard(
    id: string,
  ): Promise<{ charge: ChargeRow; transactions: TransactionRow[] } | null> {
    const charge = this.charges.get(id);
    if (!charge) return Promise.resolve(null);

    return Promise.resolve({
      charge: this.chargeRow(charge),
      transactions: [...this.transactions.values()]
        .filter((transaction) => transaction.chargeId === id)
        .map((transaction) => this.transactionRow(transaction)),
    });
  }

  countChargeTransactions(chargeId: string): Promise<number> {
    return Promise.resolve(
      [...this.transactions.values()].filter((transaction) => transaction.chargeId === chargeId)
        .length,
    );
  }

  findGroupById(id: string): Promise<{ id: string; name: string; status: GroupStatus } | null> {
    const group = this.groups.get(id);

    return Promise.resolve(group ? { id: group.id, name: group.name, status: group.status } : null);
  }

  findChargeableGroups(groupId?: string): Promise<unknown[]> {
    return Promise.resolve(
      [...this.groups.values()]
        .filter((group) => group.status !== GroupStatus.CANCELLED)
        .filter((group) => groupId === undefined || group.id === groupId)
        .map((group) => ({
          id: group.id,
          name: group.name,
          status: group.status,
          course: { id: group.courseId, title: group.courseTitle, fee: money(group.feeCents) },
          students: group.members.map((studentId) => ({ studentId })),
        })),
    );
  }

  findExistingChargeKeys(month: Date, groupIds: string[]): Promise<Set<string>> {
    return Promise.resolve(
      new Set(
        [...this.charges.values()]
          .filter(
            (charge) =>
              charge.month.getTime() === month.getTime() && groupIds.includes(charge.groupId),
          )
          .map((charge) => `${charge.groupId}:${charge.studentId}`),
      ),
    );
  }

  createCharges(month: Date, inputs: ChargeInput[]): Promise<ChargeRow[]> {
    const created: StoredCharge[] = [];

    for (const input of inputs) {
      // Уникальный ключ «студент + группа + месяц» держит сама БД —
      // повторный запуск не должен заводить вторую строку.
      const twin = [...this.charges.values()].find(
        (charge) =>
          charge.studentId === input.studentId &&
          charge.groupId === input.groupId &&
          charge.month.getTime() === month.getTime(),
      );
      if (twin) continue;

      const charge: StoredCharge = {
        id: randomUUID(),
        studentId: input.studentId,
        groupId: input.groupId,
        month,
        amountCents: input.amountCents,
        discountCents: 0,
        discountReason: null,
        paidCents: 0,
        remainingCents: input.amountCents,
        note: null,
        createdAt: new Date(),
      };

      this.charges.set(charge.id, charge);
      created.push(charge);
    }

    return Promise.resolve(created.map((charge) => this.chargeRow(charge)));
  }

  updateCharge(id: string, input: ChargeUpdateInput): Promise<ChargeRow> {
    const charge = this.charges.get(id);
    if (!charge) throw new Error('charge not found');

    if (input.discountCents !== undefined) charge.discountCents = input.discountCents;
    if (input.discountReason !== undefined) charge.discountReason = input.discountReason;
    if (input.note !== undefined) charge.note = input.note;

    this.recalc(id);

    return Promise.resolve(this.chargeRow(charge));
  }

  deleteCharge(id: string): Promise<void> {
    this.charges.delete(id);

    return Promise.resolve();
  }

  // ─────────────────────────────── Платежи ─────────────────────────────────

  findManyTransactions(
    params: TransactionListParams,
  ): Promise<{ rows: TransactionRow[]; total: number; sumCents: number }> {
    const rows = [...this.transactions.values()]
      .filter((row) => params.studentId === undefined || row.studentId === params.studentId)
      .filter((row) => params.chargeId === undefined || row.chargeId === params.chargeId)
      .filter((row) => params.typeId === undefined || row.typeId === params.typeId)
      .filter(
        (row) =>
          params.prepayment === undefined ||
          (params.prepayment ? row.chargeId === null : row.chargeId !== null),
      )
      .filter((row) => params.from === undefined || row.paidAt >= params.from)
      .filter((row) => params.to === undefined || row.paidAt < params.to)
      .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime() || a.id.localeCompare(b.id));

    return Promise.resolve({
      rows: rows
        .slice(params.skip, params.skip + params.take)
        .map((row) => this.transactionRow(row)),
      total: rows.length,
      sumCents: rows.reduce((sum, row) => sum + row.amountCents, 0),
    });
  }

  findTransactionById(id: string): Promise<TransactionRow | null> {
    const transaction = this.transactions.get(id);

    return Promise.resolve(transaction ? this.transactionRow(transaction) : null);
  }

  createTransaction(input: TransactionInput): Promise<TransactionRow> {
    const transaction: StoredTransaction = {
      id: randomUUID(),
      studentId: input.studentId,
      chargeId: input.chargeId,
      amountCents: input.amountCents,
      paidAt: input.paidAt,
      typeId: input.typeId,
      comment: input.comment,
      editReason: null,
      editedAt: null,
      createdAt: new Date(),
    };

    this.transactions.set(transaction.id, transaction);
    if (input.chargeId !== null) this.recalc(input.chargeId);

    return Promise.resolve(this.transactionRow(transaction));
  }

  updateTransaction(
    id: string,
    input: TransactionUpdateInput,
    affectedChargeIds: string[],
  ): Promise<TransactionRow> {
    const transaction = this.transactions.get(id);
    if (!transaction) throw new Error('transaction not found');

    if (input.amountCents !== undefined) transaction.amountCents = input.amountCents;
    if (input.paidAt !== undefined) transaction.paidAt = input.paidAt;
    if (input.typeId !== undefined) transaction.typeId = input.typeId;
    if (input.comment !== undefined) transaction.comment = input.comment;
    if (input.chargeId !== undefined) transaction.chargeId = input.chargeId;
    transaction.editReason = input.editReason;
    transaction.editedAt = new Date();

    for (const chargeId of affectedChargeIds) this.recalc(chargeId);

    return Promise.resolve(this.transactionRow(transaction));
  }

  deleteTransaction(id: string, chargeId: string | null): Promise<void> {
    this.transactions.delete(id);
    if (chargeId !== null) this.recalc(chargeId);

    return Promise.resolve();
  }

  // ────────────────────────────── Должники ─────────────────────────────────

  findDebts(filter: ChargeFilter): Promise<unknown[]> {
    const unpaid = this.matchCharges(filter).filter((charge) => charge.remainingCents > 0);
    const byStudent = new Map<string, StoredCharge[]>();

    for (const charge of unpaid) {
      byStudent.set(charge.studentId, [...(byStudent.get(charge.studentId) ?? []), charge]);
    }

    return Promise.resolve(
      [...byStudent.entries()].map(([studentId, charges]) => ({
        studentId,
        debtCents: charges.reduce((sum, charge) => sum + charge.remainingCents, 0),
        unpaidMonths: charges.length,
        oldestUnpaidMonth: charges
          .map((charge) => charge.month)
          .reduce((oldest, month) => (month < oldest ? month : oldest)),
      })),
    );
  }

  findChargeTotals(filter: ChargeFilter, studentIds: string[]): Promise<unknown[]> {
    const rows = this.matchCharges(filter).filter((charge) =>
      studentIds.includes(charge.studentId),
    );
    const byStudent = new Map<string, { chargedCents: number; paidCents: number }>();

    for (const charge of rows) {
      const totals = byStudent.get(charge.studentId) ?? { chargedCents: 0, paidCents: 0 };
      totals.chargedCents += Math.max(0, charge.amountCents - charge.discountCents);
      totals.paidCents += charge.paidCents;
      byStudent.set(charge.studentId, totals);
    }

    return Promise.resolve(
      [...byStudent.entries()].map(([studentId, totals]) => ({ studentId, ...totals })),
    );
  }

  findPrepaid(studentIds: string[]): Promise<{ studentId: string; cents: number }[]> {
    const byStudent = new Map<string, number>();

    for (const transaction of this.transactions.values()) {
      if (transaction.chargeId !== null || !studentIds.includes(transaction.studentId)) continue;
      byStudent.set(
        transaction.studentId,
        (byStudent.get(transaction.studentId) ?? 0) + transaction.amountCents,
      );
    }

    return Promise.resolve(
      [...byStudent.entries()].map(([studentId, cents]) => ({ studentId, cents })),
    );
  }

  findStudentsByIds(ids: string[]): Promise<StudentProfile[]> {
    return Promise.resolve(
      ids.flatMap((id) => {
        const student = this.students.get(id);

        return student === undefined
          ? []
          : [
              {
                id: student.id,
                firstName: student.firstName,
                lastName: student.lastName,
                phone: student.phone,
                status: student.status,
                branch: { id: student.branchId, name: 'Sadbarg' },
              },
            ];
      }),
    );
  }

  findStudentById(id: string): Promise<{ id: string; firstName: string; lastName: string } | null> {
    const student = this.students.get(id);

    return Promise.resolve(
      student ? { id: student.id, firstName: student.firstName, lastName: student.lastName } : null,
    );
  }

  findEmployeeByAccount(accountId: string): Promise<{ id: string } | null> {
    const id = this.employees.get(accountId);

    return Promise.resolve(id === undefined ? null : { id });
  }

  // ────────────────────────── Категории расходов ───────────────────────────

  findManyCategories(params: {
    status?: DirectoryStatus;
    search?: string;
  }): Promise<ExpenseCategoryRow[]> {
    const matches = (category: StoredCategory): boolean => {
      if (params.search === undefined) return true;
      const needle = params.search.toLowerCase();
      const self =
        category.name.toLowerCase().includes(needle) ||
        (category.description ?? '').toLowerCase().includes(needle);
      // Поиск смотрит в обе стороны дерева — как `findManyCategories` в БД.
      const parent = this.categories.get(category.parentId ?? '');
      const child = [...this.categories.values()].some(
        (candidate) =>
          candidate.parentId === category.id && candidate.name.toLowerCase().includes(needle),
      );

      return self || child || (parent?.name.toLowerCase().includes(needle) ?? false);
    };

    return Promise.resolve(
      [...this.categories.values()]
        .filter((category) => params.status === undefined || category.status === params.status)
        .filter(matches)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((category) => this.categoryRow(category)),
    );
  }

  findCategoryById(id: string): Promise<ExpenseCategoryRow | null> {
    const category = this.categories.get(id);

    return Promise.resolve(category ? this.categoryRow(category) : null);
  }

  findCategoryByName(name: string): Promise<{ id: string; name: string } | null> {
    const category = [...this.categories.values()].find(
      (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
    );

    return Promise.resolve(category ? { id: category.id, name: category.name } : null);
  }

  findCategoryNodes(): Promise<CategoryNode[]> {
    return Promise.resolve(
      [...this.categories.values()].map((category) => {
        const parent = this.categories.get(category.parentId ?? '');

        return {
          id: category.id,
          name: category.name,
          parent: parent === undefined ? null : { id: parent.id, name: parent.name },
        };
      }),
    );
  }

  findChildCategoryIds(parentId: string): Promise<string[]> {
    return Promise.resolve(
      [...this.categories.values()]
        .filter((category) => category.parentId === parentId)
        .map(({ id }) => id),
    );
  }

  createCategory(input: ExpenseCategoryWriteInput & { name: string }): Promise<ExpenseCategoryRow> {
    const id = this.seedCategory({
      name: input.name,
      description: input.description ?? null,
      parentId: input.parentId ?? null,
      status: input.status ?? DirectoryStatus.ACTIVE,
    });

    return this.findCategoryById(id) as Promise<ExpenseCategoryRow>;
  }

  updateCategory(id: string, input: ExpenseCategoryWriteInput): Promise<ExpenseCategoryRow> {
    const category = this.categories.get(id);
    if (!category) throw new Error('category not found');

    if (input.name !== undefined) category.name = input.name;
    if (input.description !== undefined) category.description = input.description;
    if (input.parentId !== undefined) category.parentId = input.parentId;
    if (input.status !== undefined) category.status = input.status;

    return this.findCategoryById(id) as Promise<ExpenseCategoryRow>;
  }

  deleteCategory(id: string): Promise<void> {
    this.categories.delete(id);

    return Promise.resolve();
  }

  private categoryRow(category: StoredCategory): ExpenseCategoryRow {
    const parent = this.categories.get(category.parentId ?? '');

    return {
      id: category.id,
      name: category.name,
      description: category.description,
      parent: parent === undefined ? null : { id: parent.id, name: parent.name },
      status: category.status,
      createdAt: category.createdAt,
      _count: {
        children: [...this.categories.values()].filter((row) => row.parentId === category.id)
          .length,
        expenses: [...this.expenses.values()].filter((row) => row.categoryId === category.id)
          .length,
        budgetLines: [...this.budgets.values()].filter((budget) =>
          budget.lines.some((line) => line.categoryId === category.id),
        ).length,
      },
    };
  }

  // ─────────────────────────────── Бюджет ──────────────────────────────────

  findManyBudgets(params: BudgetListParams): Promise<{ rows: BudgetRow[]; total: number }> {
    // Пересечение отрезков — то же условие, что в репозитории: план попадает
    // в отбор, если начался не позже конца периода и кончился не раньше начала.
    const rows = [...this.budgets.values()]
      .filter((budget) => params.status === undefined || budget.status === params.status)
      .filter(
        (budget) =>
          params.categoryId === undefined ||
          budget.lines.some((line) => line.categoryId === params.categoryId),
      )
      .filter((budget) => params.to === undefined || budget.periodFrom <= params.to)
      .filter((budget) => params.from === undefined || budget.periodTo >= params.from)
      .filter(
        (budget) =>
          params.search === undefined ||
          budget.name.toLowerCase().includes(params.search.toLowerCase()) ||
          (budget.description ?? '').toLowerCase().includes(params.search.toLowerCase()),
      )
      .sort((a, b) => b.periodFrom.getTime() - a.periodFrom.getTime() || a.id.localeCompare(b.id));

    return Promise.resolve({
      rows: rows.slice(params.skip, params.skip + params.take).map((row) => this.budgetRow(row)),
      total: rows.length,
    });
  }

  findBudgetById(id: string): Promise<BudgetRow | null> {
    const budget = this.budgets.get(id);

    return Promise.resolve(budget === undefined ? null : this.budgetRow(budget));
  }

  findBudgetByName(name: string): Promise<{ id: string; name: string } | null> {
    const twin = [...this.budgets.values()].find(
      (budget) => budget.name.toLowerCase() === name.toLowerCase(),
    );

    return Promise.resolve(twin === undefined ? null : { id: twin.id, name: twin.name });
  }

  createBudget(input: BudgetCreateInput): Promise<BudgetRow> {
    const id = randomUUID();
    this.budgets.set(id, {
      id,
      name: input.name,
      description: input.description,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      status: input.status ?? BudgetStatus.DRAFT,
      salaryAllocatedCents: input.salaryAllocatedCents,
      lines: input.lines.map((line) => ({ id: randomUUID(), ...line })),
      createdAt: new Date(),
    });

    return Promise.resolve(this.budgetRow(this.budgets.get(id) as StoredBudget));
  }

  updateBudget(id: string, input: BudgetUpdateInput): Promise<BudgetRow> {
    const budget = this.budgets.get(id) as StoredBudget;

    if (input.name !== undefined) budget.name = input.name;
    if (input.description !== undefined) budget.description = input.description;
    if (input.periodFrom !== undefined) budget.periodFrom = input.periodFrom;
    if (input.periodTo !== undefined) budget.periodTo = input.periodTo;
    if (input.status !== undefined) budget.status = input.status;
    if (input.salaryAllocatedCents !== undefined) {
      budget.salaryAllocatedCents = input.salaryAllocatedCents;
    }
    // Набор строк заменяется целиком — как `deleteMany` + `createMany` в БД.
    if (input.lines !== undefined) {
      budget.lines = input.lines.map((line) => ({ id: randomUUID(), ...line }));
    }

    return Promise.resolve(this.budgetRow(budget));
  }

  deleteBudget(id: string): Promise<void> {
    this.budgets.delete(id);

    return Promise.resolve();
  }

  /** Агрегат расходов по статьям за окно — то же, что `groupBy` в БД. */
  findExpenseTotalsByCategory(
    from: Date,
    to: Date,
    categoryIds: string[],
  ): Promise<Map<string, number>> {
    const totals = new Map<string, number>();

    for (const expense of this.expenses.values()) {
      if (expense.spentAt < from || expense.spentAt >= to) continue;
      if (!categoryIds.includes(expense.categoryId)) continue;

      totals.set(expense.categoryId, (totals.get(expense.categoryId) ?? 0) + expense.amountCents);
    }

    return Promise.resolve(totals);
  }

  findChildIdsByParents(parentIds: string[]): Promise<Map<string, string[]>> {
    const children = new Map<string, string[]>();

    for (const category of this.categories.values()) {
      if (category.parentId === null || !parentIds.includes(category.parentId)) continue;
      children.set(category.parentId, [...(children.get(category.parentId) ?? []), category.id]);
    }

    return Promise.resolve(children);
  }

  findCategoriesByIds(
    ids: string[],
  ): Promise<{ id: string; name: string; status: DirectoryStatus; parentId: string | null }[]> {
    return Promise.resolve(
      ids.flatMap((id) => {
        const category = this.categories.get(id);

        return category === undefined
          ? []
          : [
              {
                id: category.id,
                name: category.name,
                status: category.status,
                parentId: category.parentId,
              },
            ];
      }),
    );
  }

  private budgetRow(budget: StoredBudget): BudgetRow {
    return {
      id: budget.id,
      name: budget.name,
      description: budget.description,
      periodFrom: budget.periodFrom,
      periodTo: budget.periodTo,
      status: budget.status,
      salaryAllocated:
        budget.salaryAllocatedCents === null
          ? null
          : new Prisma.Decimal(money(budget.salaryAllocatedCents)),
      createdAt: budget.createdAt,
      createdBy: null,
      lines: budget.lines
        .map((line) => {
          const category = this.categories.get(line.categoryId);
          const parent = this.categories.get(category?.parentId ?? '');

          return {
            id: line.id,
            // Настоящий `Decimal`, как отдала бы БД: строка сюда не подошла бы
            // по типу, а сервис переводит значение в тыйины через `Number()`.
            allocated: new Prisma.Decimal(money(line.allocatedCents)),
            note: line.note,
            category: {
              id: line.categoryId,
              name: category?.name ?? '—',
              parent: parent === undefined ? null : { id: parent.id, name: parent.name },
            },
          };
        })
        .sort((a, b) => a.category.name.localeCompare(b.category.name)),
    };
  }

  // ────────────────────────────── Зарплата ─────────────────────────────────
  //
  // Хранилище **повторяет правила репозитория**: часы складываются из дней
  // журнала, ставка ищется по точному месяцу (предыдущий не тянется, 0021),
  // «Prepaid» берётся только из одобренных заявок, а подтверждение пишет три
  // колонки снимка вместе — ровно то, что делает БД.

  findManySalaries(params: SalaryListParams): Promise<{ rows: SalaryRow[]; total: number }> {
    const rows = this.matchSalaries(params).sort((a, b) => {
      const left = this.employeeProfiles.get(a.employeeId);
      const right = this.employeeProfiles.get(b.employeeId);

      const asc =
        params.sort === SalarySortField.Total
          ? (a.totalCents ?? 0) - (b.totalCents ?? 0)
          : params.sort === SalarySortField.CreatedAt
            ? a.createdAt.getTime() - b.createdAt.getTime()
            : (left?.lastName ?? '').localeCompare(right?.lastName ?? '', 'ru');

      return (params.order === SortOrder.Asc ? asc : -asc) || a.id.localeCompare(b.id);
    });

    return Promise.resolve({
      rows: rows.slice(params.skip, params.skip + params.take).map((row) => this.salaryRow(row)),
      total: rows.length,
    });
  }

  findSalarySetRows(filter: SalaryFilter): Promise<
    {
      id: string;
      employeeId: string;
      bonus: Prisma.Decimal;
      status: SalaryStatus;
      minutes: number | null;
      hourlyRate: Prisma.Decimal | null;
      total: Prisma.Decimal | null;
    }[]
  > {
    return Promise.resolve(
      this.matchSalaries(filter).map((row) => ({
        id: row.id,
        employeeId: row.employeeId,
        bonus: new Prisma.Decimal(money(row.bonusCents)),
        status: row.status,
        minutes: row.minutes,
        hourlyRate:
          row.hourlyRateCents === null ? null : new Prisma.Decimal(money(row.hourlyRateCents)),
        total: row.totalCents === null ? null : new Prisma.Decimal(money(row.totalCents)),
      })),
    );
  }

  findSalaryById(id: string): Promise<SalaryRow | null> {
    const row = this.salaries.get(id);

    return Promise.resolve(row === undefined ? null : this.salaryRow(row));
  }

  findTaughtMinutes(from: Date, to: Date, employeeIds: string[]): Promise<Map<string, number>> {
    const minutes = new Map<string, number>();

    for (const day of this.taughtDays) {
      if (!employeeIds.includes(day.mentorId)) continue;
      if (day.date < from || day.date >= to) continue;

      minutes.set(day.mentorId, (minutes.get(day.mentorId) ?? 0) + (day.minutes ?? 0));
    }

    return Promise.resolve(minutes);
  }

  findMonthLevels(month: Date, employeeIds: string[]): Promise<Map<string, MonthLevel>> {
    const levels = new Map<string, MonthLevel>();

    for (const level of this.monthLevels) {
      if (!employeeIds.includes(level.employeeId)) continue;
      // Точное равенство месяца: ближайший предыдущий не тянется (0021).
      if (level.month.getTime() !== month.getTime()) continue;

      levels.set(level.employeeId, {
        employeeId: level.employeeId,
        levelId: level.levelId,
        levelName: level.levelName,
        hourlyRateCents: level.hourlyRateCents,
      });
    }

    return Promise.resolve(levels);
  }

  findApprovedAvansTotals(month: Date, employeeIds: string[]): Promise<Map<string, number>> {
    const totals = new Map<string, number>();

    for (const avans of this.approvedAvans) {
      if (!employeeIds.includes(avans.employeeId)) continue;
      if (avans.month.getTime() !== month.getTime()) continue;

      totals.set(avans.employeeId, (totals.get(avans.employeeId) ?? 0) + avans.amountCents);
    }

    return Promise.resolve(totals);
  }

  findSalaryPaidTotals(salaryIds: string[]): Promise<Map<string, number>> {
    const totals = new Map<string, number>();

    for (const payment of this.salaryTransactions.values()) {
      if (!salaryIds.includes(payment.salaryId)) continue;
      totals.set(payment.salaryId, (totals.get(payment.salaryId) ?? 0) + payment.amountCents);
    }

    return Promise.resolve(totals);
  }

  findTaughtDays(from: Date, to: Date, mentorId: string): Promise<SalaryDayFact[]> {
    return Promise.resolve(
      this.taughtDays
        .filter((day) => day.mentorId === mentorId && day.date >= from && day.date < to)
        .map((day) => ({
          date: day.date,
          minutes: day.minutes ?? 0,
          group:
            day.groupId === null
              ? null
              : { id: day.groupId, name: this.groups.get(day.groupId)?.name ?? '—' },
        })),
    );
  }

  findSalaryCandidates(from: Date, to: Date, employeeId?: string): Promise<string[]> {
    const ids = new Set<string>();

    for (const day of this.taughtDays) {
      if (day.date < from || day.date >= to) continue;
      if (employeeId !== undefined && day.mentorId !== employeeId) continue;
      ids.add(day.mentorId);
    }

    for (const avans of this.approvedAvans) {
      if (avans.month.getTime() !== from.getTime()) continue;
      if (employeeId !== undefined && avans.employeeId !== employeeId) continue;
      ids.add(avans.employeeId);
    }

    return Promise.resolve([...ids]);
  }

  createSalaries(month: Date, employeeIds: string[], createdById: string | null): Promise<number> {
    let created = 0;

    for (const employeeId of employeeIds) {
      // Уникальный `(employeeId, month)` — на нём держится идемпотентность.
      const twin = [...this.salaries.values()].find(
        (row) => row.employeeId === employeeId && row.month.getTime() === month.getTime(),
      );
      if (twin !== undefined) continue;

      const id = randomUUID();
      this.salaries.set(id, {
        id,
        employeeId,
        month,
        bonusCents: 0,
        note: null,
        status: SalaryStatus.DRAFT,
        minutes: null,
        hourlyRateCents: null,
        totalCents: null,
        confirmedAt: null,
        confirmedById: null,
        createdById,
        createdAt: new Date(),
      });
      created += 1;
    }

    return Promise.resolve(created);
  }

  updateSalary(id: string, input: SalaryUpdateInput): Promise<SalaryRow> {
    const row = this.salaries.get(id) as StoredSalary;

    if (input.bonusCents !== undefined) row.bonusCents = input.bonusCents;
    if (input.note !== undefined) row.note = input.note;

    return Promise.resolve(this.salaryRow(row));
  }

  confirmSalary(id: string, input: SalaryConfirmInput): Promise<SalaryRow> {
    const row = this.salaries.get(id) as StoredSalary;

    row.status = SalaryStatus.DONE;
    row.minutes = input.minutes;
    row.hourlyRateCents = input.hourlyRateCents;
    row.totalCents = input.totalCents;
    row.confirmedAt = input.confirmedAt;
    row.confirmedById = input.confirmedById;

    return Promise.resolve(this.salaryRow(row));
  }

  unconfirmSalary(id: string): Promise<SalaryRow> {
    const row = this.salaries.get(id) as StoredSalary;

    row.status = SalaryStatus.DRAFT;
    row.minutes = null;
    row.hourlyRateCents = null;
    row.totalCents = null;
    row.confirmedAt = null;
    row.confirmedById = null;

    return Promise.resolve(this.salaryRow(row));
  }

  deleteSalary(id: string): Promise<void> {
    this.salaries.delete(id);

    return Promise.resolve();
  }

  findSalaryTransactions(salaryId: string): Promise<SalaryTransactionRow[]> {
    return Promise.resolve(
      [...this.salaryTransactions.values()]
        .filter((payment) => payment.salaryId === salaryId)
        .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime())
        .map((payment) => this.salaryTransactionRow(payment)),
    );
  }

  countSalaryTransactions(salaryId: string): Promise<number> {
    return Promise.resolve(
      [...this.salaryTransactions.values()].filter((payment) => payment.salaryId === salaryId)
        .length,
    );
  }

  createSalaryTransaction(input: SalaryTransactionInput): Promise<SalaryTransactionRow> {
    const id = randomUUID();
    this.salaryTransactions.set(id, {
      id,
      salaryId: input.salaryId,
      amountCents: input.amountCents,
      paidAt: input.paidAt,
      typeId: input.typeId,
      comment: input.comment,
      createdAt: new Date(),
    });

    return Promise.resolve(
      this.salaryTransactionRow(this.salaryTransactions.get(id) as StoredSalaryTransaction),
    );
  }

  findSalaryTransactionById(
    id: string,
  ): Promise<(SalaryTransactionRow & { salaryId: string }) | null> {
    const payment = this.salaryTransactions.get(id);

    return Promise.resolve(
      payment === undefined
        ? null
        : { ...this.salaryTransactionRow(payment), salaryId: payment.salaryId },
    );
  }

  deleteSalaryTransaction(id: string): Promise<void> {
    this.salaryTransactions.delete(id);

    return Promise.resolve();
  }

  findSalaryFacts(from: Date, to: Date): Promise<MoneyFact[]> {
    return Promise.resolve(
      [...this.salaryTransactions.values()]
        .filter((payment) => payment.paidAt >= from && payment.paidAt < to)
        .map((payment) => ({ at: payment.paidAt, cents: payment.amountCents })),
    );
  }

  sumSalaryPaid(from: Date, to: Date): Promise<number> {
    return Promise.resolve(
      [...this.salaryTransactions.values()]
        .filter((payment) => payment.paidAt >= from && payment.paidAt < to)
        .reduce((total, payment) => total + payment.amountCents, 0),
    );
  }

  findEmployeeById(
    id: string,
  ): Promise<{ id: string; firstName: string; lastName: string; status: string } | null> {
    const employee = this.employeeProfiles.get(id);

    return Promise.resolve(
      employee === undefined
        ? null
        : {
            id: employee.id,
            firstName: employee.firstName,
            lastName: employee.lastName,
            status: employee.status,
          },
    );
  }

  private matchSalaries(filter: SalaryFilter): StoredSalary[] {
    return [...this.salaries.values()].filter((row) => {
      if (row.month.getTime() !== filter.month.getTime()) return false;
      if (filter.status !== undefined && row.status !== filter.status) return false;
      if (filter.employeeId !== undefined && row.employeeId !== filter.employeeId) return false;

      const employee = this.employeeProfiles.get(row.employeeId);
      if (filter.branchId !== undefined && employee?.branchId !== filter.branchId) return false;

      if (filter.search !== undefined) {
        const needle = filter.search.toLowerCase();
        const haystack = [employee?.firstName, employee?.lastName, employee?.phone]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }

      return true;
    });
  }

  private salaryRow(row: StoredSalary): SalaryRow {
    const employee = this.employeeProfiles.get(row.employeeId);

    return {
      id: row.id,
      month: row.month,
      bonus: new Prisma.Decimal(money(row.bonusCents)),
      note: row.note,
      status: row.status,
      minutes: row.minutes,
      hourlyRate:
        row.hourlyRateCents === null ? null : new Prisma.Decimal(money(row.hourlyRateCents)),
      total: row.totalCents === null ? null : new Prisma.Decimal(money(row.totalCents)),
      confirmedAt: row.confirmedAt,
      createdAt: row.createdAt,
      employee: {
        id: row.employeeId,
        firstName: employee?.firstName ?? '—',
        lastName: employee?.lastName ?? '—',
        phone: employee?.phone ?? '—',
        branch:
          employee?.branchId == null
            ? null
            : { id: employee.branchId, name: this.branches.get(employee.branchId) ?? '—' },
      },
      confirmedBy: this.personOf(row.confirmedById),
      createdBy: this.personOf(row.createdById),
    };
  }

  private personOf(
    employeeId: string | null,
  ): { id: string; firstName: string; lastName: string } | null {
    if (employeeId === null) return null;

    const employee = this.employeeProfiles.get(employeeId);

    return {
      id: employeeId,
      firstName: employee?.firstName ?? '—',
      lastName: employee?.lastName ?? '—',
    };
  }

  private salaryTransactionRow(row: StoredSalaryTransaction): SalaryTransactionRow {
    return {
      id: row.id,
      amount: new Prisma.Decimal(money(row.amountCents)),
      paidAt: row.paidAt,
      comment: row.comment,
      createdAt: row.createdAt,
      type: { id: row.typeId, name: this.types.get(row.typeId)?.name ?? '—' },
      createdBy: null,
    };
  }

  // ────────────────────────────── Расходы ──────────────────────────────────

  findManyExpenses(
    params: ExpenseListParams,
  ): Promise<{ rows: ExpenseRow[]; total: number; sumCents: number }> {
    const rows = this.matchExpenses(params).sort(
      (a, b) => b.spentAt.getTime() - a.spentAt.getTime() || a.id.localeCompare(b.id),
    );

    return Promise.resolve({
      rows: rows.slice(params.skip, params.skip + params.take).map((row) => this.expenseRow(row)),
      total: rows.length,
      sumCents: rows.reduce((sum, row) => sum + row.amountCents, 0),
    });
  }

  findExpenseById(id: string): Promise<ExpenseRow | null> {
    const expense = this.expenses.get(id);

    return Promise.resolve(expense ? this.expenseRow(expense) : null);
  }

  createExpense(input: ExpenseInput): Promise<ExpenseRow> {
    const expense: StoredExpense = {
      id: randomUUID(),
      categoryId: input.categoryId,
      title: input.title,
      amountCents: input.amountCents,
      spentAt: input.spentAt,
      branchId: input.branchId,
      note: input.note,
      createdAt: new Date(),
    };

    this.expenses.set(expense.id, expense);

    return Promise.resolve(this.expenseRow(expense));
  }

  updateExpense(id: string, input: ExpenseUpdateInput): Promise<ExpenseRow> {
    const expense = this.expenses.get(id);
    if (!expense) throw new Error('expense not found');

    if (input.categoryId !== undefined) expense.categoryId = input.categoryId;
    if (input.title !== undefined) expense.title = input.title;
    if (input.amountCents !== undefined) expense.amountCents = input.amountCents;
    if (input.spentAt !== undefined) expense.spentAt = input.spentAt;
    if (input.branchId !== undefined) expense.branchId = input.branchId;
    if (input.note !== undefined) expense.note = input.note;

    return Promise.resolve(this.expenseRow(expense));
  }

  deleteExpense(id: string): Promise<void> {
    this.expenses.delete(id);

    return Promise.resolve();
  }

  findBranchById(id: string): Promise<{ id: string; name: string; status: string } | null> {
    const name = this.branches.get(id);

    return Promise.resolve(name === undefined ? null : { id, name, status: 'ACTIVE' });
  }

  private matchExpenses(filter: ExpenseFilter): StoredExpense[] {
    return [...this.expenses.values()].filter((expense) => {
      const searchOk =
        filter.search === undefined ||
        [expense.title, expense.note, this.categories.get(expense.categoryId)?.name].some((value) =>
          (value ?? '').toLowerCase().includes(filter.search?.toLowerCase() ?? ''),
        );

      return (
        (filter.categoryIds === undefined || filter.categoryIds.includes(expense.categoryId)) &&
        (filter.branchId === undefined || expense.branchId === filter.branchId) &&
        (filter.from === undefined || expense.spentAt >= filter.from) &&
        (filter.to === undefined || expense.spentAt < filter.to) &&
        searchOk
      );
    });
  }

  private expenseRow(expense: StoredExpense): ExpenseRow {
    const category = this.categories.get(expense.categoryId);
    const parent = this.categories.get(category?.parentId ?? '');

    return {
      id: expense.id,
      title: expense.title,
      amount: money(expense.amountCents),
      spentAt: expense.spentAt,
      note: expense.note,
      createdAt: expense.createdAt,
      category: {
        id: expense.categoryId,
        name: category?.name ?? '—',
        parent: parent === undefined ? null : { id: parent.id, name: parent.name },
      },
      branch:
        expense.branchId === null
          ? null
          : { id: expense.branchId, name: this.branches.get(expense.branchId) ?? '—' },
      createdBy: null,
    } as unknown as ExpenseRow;
  }

  // ─────────────────────────────── Обзор ───────────────────────────────────

  findIncomeFacts(from: Date, to: Date): Promise<MoneyFact[]> {
    return Promise.resolve(
      [...this.transactions.values()]
        .filter((row) => row.paidAt >= from && row.paidAt < to)
        .map((row) => ({ at: row.paidAt, cents: row.amountCents })),
    );
  }

  findExpenseFacts(from: Date, to: Date): Promise<(MoneyFact & ExpenseFact)[]> {
    return Promise.resolve(
      [...this.expenses.values()]
        .filter((row) => row.spentAt >= from && row.spentAt < to)
        .map((row) => ({ at: row.spentAt, cents: row.amountCents, categoryId: row.categoryId })),
    );
  }

  findGroupChargeFacts(filter: ChargeFilter): Promise<GroupChargeFact[]> {
    const byPair = new Map<string, GroupChargeFact>();

    for (const charge of this.matchCharges(filter)) {
      const key = `${charge.groupId}:${charge.studentId}`;
      const fact = byPair.get(key) ?? {
        groupId: charge.groupId,
        studentId: charge.studentId,
        chargedCents: 0,
        paidCents: 0,
        debtCents: 0,
      };

      fact.chargedCents += Math.max(0, charge.amountCents - charge.discountCents);
      fact.paidCents += charge.paidCents;
      fact.debtCents += charge.remainingCents;
      byPair.set(key, fact);
    }

    return Promise.resolve([...byPair.values()]);
  }

  findGroupsByIds(ids: string[]): Promise<GroupRef[]> {
    return Promise.resolve(
      ids.flatMap((id) => {
        const group = this.groups.get(id);

        return group === undefined
          ? []
          : [
              {
                id: group.id,
                name: group.name,
                course: { id: group.courseId, name: group.courseTitle },
                branch: { id: group.branchId, name: this.branches.get(group.branchId) ?? '—' },
              },
            ];
      }),
    );
  }

  // ───────────────────────────── Внутреннее ────────────────────────────────

  /** Пересчёт принятой суммы и остатка — то же, что делает `recalcCharge` в БД. */
  private recalc(chargeId: string): void {
    const charge = this.charges.get(chargeId);
    if (!charge) return;

    const paidCents = [...this.transactions.values()]
      .filter((transaction) => transaction.chargeId === chargeId)
      .reduce((sum, transaction) => sum + transaction.amountCents, 0);

    charge.paidCents = paidCents;
    charge.remainingCents = Math.max(
      0,
      Math.max(0, charge.amountCents - charge.discountCents) - paidCents,
    );
  }

  private matchCharges(filter: ChargeFilter): StoredCharge[] {
    return [...this.charges.values()].filter((charge) => {
      const group = this.groups.get(charge.groupId);
      const student = this.students.get(charge.studentId);
      const dueCents = Math.max(0, charge.amountCents - charge.discountCents);

      const statusOk =
        filter.status === undefined ||
        (filter.status === ChargeStatus.Paid
          ? charge.remainingCents === 0
          : filter.status === ChargeStatus.Partial
            ? charge.remainingCents > 0 && charge.paidCents > 0
            : charge.remainingCents > 0 && charge.paidCents === 0);

      const searchOk =
        filter.search === undefined ||
        [student?.lastName, student?.firstName, student?.phone, group?.name].some((value) =>
          (value ?? '').toLowerCase().includes(filter.search?.toLowerCase() ?? ''),
        );

      return (
        (filter.studentId === undefined || charge.studentId === filter.studentId) &&
        (filter.groupId === undefined || charge.groupId === filter.groupId) &&
        (filter.courseId === undefined || group?.courseId === filter.courseId) &&
        (filter.branchId === undefined || group?.branchId === filter.branchId) &&
        (filter.from === undefined || charge.month >= filter.from) &&
        (filter.to === undefined || charge.month < filter.to) &&
        statusOk &&
        searchOk &&
        dueCents >= 0
      );
    });
  }

  private chargeRow(charge: StoredCharge): ChargeRow {
    const student = this.students.get(charge.studentId);
    const group = this.groups.get(charge.groupId);

    return {
      id: charge.id,
      month: charge.month,
      amount: money(charge.amountCents),
      discount: money(charge.discountCents),
      discountReason: charge.discountReason,
      paidAmount: money(charge.paidCents),
      remainingAmount: money(charge.remainingCents),
      note: charge.note,
      createdAt: charge.createdAt,
      student: {
        id: charge.studentId,
        firstName: student?.firstName ?? '—',
        lastName: student?.lastName ?? '—',
        phone: student?.phone ?? '—',
      },
      group: {
        id: charge.groupId,
        name: group?.name ?? '—',
        course: { id: group?.courseId ?? '—', title: group?.courseTitle ?? '—' },
        branch: { id: group?.branchId ?? 'branch-1', name: 'Sadbarg' },
      },
      createdBy: null,
    } as unknown as ChargeRow;
  }

  private transactionRow(transaction: StoredTransaction): TransactionRow {
    const student = this.students.get(transaction.studentId);
    const charge = transaction.chargeId === null ? null : this.charges.get(transaction.chargeId);
    const type = transaction.typeId === null ? null : this.types.get(transaction.typeId);

    return {
      id: transaction.id,
      amount: money(transaction.amountCents),
      paidAt: transaction.paidAt,
      comment: transaction.comment,
      editReason: transaction.editReason,
      editedAt: transaction.editedAt,
      createdAt: transaction.createdAt,
      student: {
        id: transaction.studentId,
        firstName: student?.firstName ?? '—',
        lastName: student?.lastName ?? '—',
        phone: student?.phone ?? '—',
      },
      charge:
        charge === undefined || charge === null
          ? null
          : {
              id: charge.id,
              month: charge.month,
              group: {
                id: charge.groupId,
                name: this.groups.get(charge.groupId)?.name ?? '—',
              },
            },
      type: type === undefined || type === null ? null : { id: type.id, name: type.name },
      createdBy: null,
      editedBy: null,
    } as unknown as TransactionRow;
  }
  // ───────────── Финансовые периоды-отчёты (ТЗ 5.16, сессия 0033) ───────────

  /** Сколько периодов заведено — им проверяется «а не записалось ли». */
  periodCount(): number {
    return this.periods.size;
  }

  findManyPeriods(
    params: AccountingPeriodListParams,
  ): Promise<{ rows: AccountingPeriodRow[]; total: number }> {
    const rows = [...this.periods.values()]
      .filter((period) => params.status === undefined || period.status === params.status)
      // Пересечение отрезков — то же правило, что в БД.
      .filter((period) => params.to === undefined || period.periodFrom <= params.to)
      .filter((period) => params.from === undefined || period.periodTo >= params.from)
      .filter(
        (period) =>
          params.search === undefined ||
          period.name.toLowerCase().includes(params.search.toLowerCase()),
      )
      .sort((a, b) =>
        params.sort === AccountingPeriodSortField.Name
          ? a.name.localeCompare(b.name)
          : b.periodFrom.getTime() - a.periodFrom.getTime() || a.id.localeCompare(b.id),
      );

    return Promise.resolve({
      rows: rows.slice(params.skip, params.skip + params.take).map((row) => this.periodRow(row)),
      total: rows.length,
    });
  }

  findPeriodById(id: string): Promise<AccountingPeriodRow | null> {
    const period = this.periods.get(id);

    return Promise.resolve(period === undefined ? null : this.periodRow(period));
  }

  findPeriodByName(name: string): Promise<{ id: string; name: string } | null> {
    const twin = [...this.periods.values()].find(
      (period) => period.name.toLowerCase() === name.toLowerCase(),
    );

    return Promise.resolve(twin === undefined ? null : { id: twin.id, name: twin.name });
  }

  findOverlappingPeriod(
    from: Date,
    to: Date,
    exceptId?: string,
  ): Promise<{ id: string; name: string; periodFrom: Date; periodTo: Date } | null> {
    const clash = [...this.periods.values()].find(
      (period) => period.id !== exceptId && period.periodFrom <= to && period.periodTo >= from,
    );

    return Promise.resolve(
      clash === undefined
        ? null
        : {
            id: clash.id,
            name: clash.name,
            periodFrom: clash.periodFrom,
            periodTo: clash.periodTo,
          },
    );
  }

  /** Запрос, на котором держится вся защита кассы от правок задним числом. */
  findArchivedPeriodForMonth(
    month: Date,
  ): Promise<{ id: string; name: string; periodFrom: Date; periodTo: Date } | null> {
    const period = [...this.periods.values()].find(
      (row) =>
        row.status === AccountingPeriodStatus.ARCHIVED &&
        row.periodFrom <= month &&
        row.periodTo >= month,
    );

    return Promise.resolve(
      period === undefined
        ? null
        : {
            id: period.id,
            name: period.name,
            periodFrom: period.periodFrom,
            periodTo: period.periodTo,
          },
    );
  }

  createPeriod(input: AccountingPeriodCreateInput): Promise<AccountingPeriodRow> {
    const id = randomUUID();
    this.periods.set(id, {
      id,
      name: input.name,
      description: input.description,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      status: AccountingPeriodStatus.IN_PROGRESS,
      snapshot: null,
      closedAt: null,
      createdAt: new Date(),
    });

    return Promise.resolve(this.periodRow(this.periods.get(id) as StoredPeriod));
  }

  updatePeriod(id: string, input: AccountingPeriodUpdateInput): Promise<AccountingPeriodRow> {
    const period = this.periods.get(id) as StoredPeriod;
    if (input.name !== undefined) period.name = input.name;
    if (input.description !== undefined) period.description = input.description;
    if (input.periodFrom !== undefined) period.periodFrom = input.periodFrom;
    if (input.periodTo !== undefined) period.periodTo = input.periodTo;

    return Promise.resolve(this.periodRow(period));
  }

  /** Снимок пишется целиком вместе со статусом — как одна запись в БД. */
  closePeriod(id: string, input: AccountingPeriodCloseInput): Promise<AccountingPeriodRow> {
    const period = this.periods.get(id) as StoredPeriod;
    period.status = AccountingPeriodStatus.ARCHIVED;
    period.snapshot = { ...input.facts };
    period.closedAt = input.closedAt;

    return Promise.resolve(this.periodRow(period));
  }

  reopenPeriod(id: string): Promise<AccountingPeriodRow> {
    const period = this.periods.get(id) as StoredPeriod;
    period.status = AccountingPeriodStatus.IN_PROGRESS;
    period.snapshot = null;
    period.closedAt = null;

    return Promise.resolve(this.periodRow(period));
  }

  deletePeriod(id: string): Promise<void> {
    this.periods.delete(id);

    return Promise.resolve();
  }

  sumIncome(from: Date, to: Date): Promise<number> {
    return Promise.resolve(
      [...this.transactions.values()]
        .filter((row) => row.paidAt >= from && row.paidAt < to)
        .reduce((total, row) => total + row.amountCents, 0),
    );
  }

  sumExpenses(from: Date, to: Date): Promise<number> {
    return Promise.resolve(
      [...this.expenses.values()]
        .filter((row) => row.spentAt >= from && row.spentAt < to)
        .reduce((total, row) => total + row.amountCents, 0),
    );
  }

  findMonthlyChargeTotals(
    from: Date,
    to: Date,
  ): Promise<{ month: Date; chargedCents: number; paidCents: number }[]> {
    const byMonth = new Map<number, { month: Date; chargedCents: number; paidCents: number }>();

    for (const charge of this.charges.values()) {
      if (charge.month < from || charge.month >= to) continue;

      const bucket = byMonth.get(charge.month.getTime()) ?? {
        month: charge.month,
        chargedCents: 0,
        paidCents: 0,
      };
      bucket.chargedCents += Math.max(0, charge.amountCents - charge.discountCents);
      bucket.paidCents += charge.paidCents;
      byMonth.set(charge.month.getTime(), bucket);
    }

    return Promise.resolve([...byMonth.values()]);
  }

  private periodRow(period: StoredPeriod): AccountingPeriodRow {
    const snapshot = period.snapshot;

    return {
      id: period.id,
      name: period.name,
      description: period.description,
      periodFrom: period.periodFrom,
      periodTo: period.periodTo,
      status: period.status,
      charged: snapshot === null ? null : new Prisma.Decimal(money(snapshot.chargedCents)),
      paid: snapshot === null ? null : new Prisma.Decimal(money(snapshot.paidCents)),
      income: snapshot === null ? null : new Prisma.Decimal(money(snapshot.incomeCents)),
      expense: snapshot === null ? null : new Prisma.Decimal(money(snapshot.expenseCents)),
      salary: snapshot === null ? null : new Prisma.Decimal(money(snapshot.salaryCents)),
      closedAt: period.closedAt,
      createdAt: period.createdAt,
      closedBy: null,
      createdBy: null,
    };
  }
}

describe('Бухгалтерия: оплаты и должники (ТЗ 5.16)', () => {
  let app: INestApplication;
  let store: InMemoryStore;
  let rbac: InMemoryRbacRepository;
  let tokens: TokenService;

  beforeEach(async () => {
    store = new InMemoryStore();
    rbac = new InMemoryRbacRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        PhoneModule,
        AuthModule,
        RbacModule,
        AccountingModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
      ],
    })
      .overrideProvider(AuthRepository)
      .useValue({})
      .overrideProvider(RbacRepository)
      .useValue(rbac)
      .overrideProvider(AccountingRepository)
      .useValue(store)
      .compile();

    tokens = moduleRef.get(TokenService, { strict: false });

    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  const actor = async (codes: string[]): Promise<{ token: string; accountId: string }> => {
    const accountId = randomUUID();
    rbac.grant(accountId, codes);
    store.addEmployee(accountId);
    const { accessToken } = await tokens.issuePair({
      sub: accountId,
      sid: randomUUID(),
      type: AccountType.EMPLOYEE,
    });

    return { token: accessToken, accountId };
  };

  const viewer = async () => (await actor(['Permission.Accounting.Views'])).token;
  const cashier = async () =>
    (await actor(['Permission.Accounting.Views', 'Permission.Accounting.ManagePayments'])).token;
  const accountant = async () =>
    (await actor(['Permission.Accounting.Views', 'Permission.Accounting.ManageExpenses'])).token;
  /** Ведёт бюджет: планирует, но расходов не проводит — права разные. */
  const planner = async () =>
    (await actor(['Permission.Accounting.Views', 'Permission.Accounting.ManageBudget'])).token;
  /** Полные права раздела: обзор сводит и кассу, и расходы. */
  const director = async () =>
    (
      await actor([
        'Permission.Accounting.Views',
        'Permission.Accounting.ManagePayments',
        'Permission.Accounting.ManageExpenses',
      ])
    ).token;

  const studentToken = async (): Promise<string> =>
    (await tokens.issuePair({ sub: randomUUID(), sid: randomUUID(), type: AccountType.STUDENT }))
      .accessToken;

  const get = (url: string, token: string) =>
    request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);

  const send = (method: 'post' | 'put' | 'delete', url: string, token: string, body?: object) => {
    const req = request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`);

    return body === undefined ? req : req.send(body);
  };

  /** Группа с одним студентом и стоимостью курса 1200 TJS. */
  const seedGroup = (feeCents = 120000): { groupId: string; studentId: string } => {
    const groupId = store.addGroup({ feeCents });
    const studentId = store.addStudent();
    store.enroll(groupId, studentId);

    return { groupId, studentId };
  };

  /** Начисление месяца настоящим маршрутом — возвращает единственную строку. */
  const chargeMonth = async (
    token: string,
    month: string,
    groupId?: string,
  ): Promise<{ id: string; remaining: number; status: ChargeStatus }> => {
    const response = await send('post', '/api/v1/accounting/payments/charges', token, {
      month,
      ...(groupId === undefined ? {} : { groupId }),
    }).expect(201);

    const { charges } = dataOf<{
      charges: { id: string; remaining: number; status: ChargeStatus }[];
    }>(response);

    return charges[0];
  };

  describe('Доступ', () => {
    it('без токена — 401', async () => {
      await request(app.getHttpServer()).get('/api/v1/accounting/payments').expect(401);
    });

    it('студенту бухгалтерия закрыта — 403', async () => {
      await get('/api/v1/accounting/payments', await studentToken()).expect(403);
      await get('/api/v1/accounting/debtors', await studentToken()).expect(403);
    });

    it('сотрудник без прав — 403', async () => {
      const token = (await actor([])).token;

      await get('/api/v1/accounting/payments', token).expect(403);
      await get('/api/v1/accounting/payment-types', token).expect(403);
    });

    it('право на просмотр не даёт принимать оплату и начислять месяц', async () => {
      const token = await viewer();

      await get('/api/v1/accounting/payments', token).expect(200);
      await send('post', '/api/v1/accounting/payments/charges', token, {
        month: '2026-09',
      }).expect(403);
      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: randomUUID(),
        amount: 100,
      }).expect(403);
    });

    it('право на оплаты не открывается правом на студентов', async () => {
      const token = (await actor(['Permission.Students.Views'])).token;

      await get('/api/v1/accounting/payments', token).expect(403);
    });
  });

  describe('Начисление месяца', () => {
    it('заводит месяц каждому студенту действующего состава по стоимости курса', async () => {
      const token = await cashier();
      const { groupId, studentId } = seedGroup();
      store.enroll(groupId, store.addStudent({ lastName: 'Раҳимов' }));

      const response = await send('post', '/api/v1/accounting/payments/charges', token, {
        month: '2026-09',
        groupId,
      }).expect(201);

      const result = dataOf<{
        month: string;
        created: number;
        skipped: number;
        charges: { student: { id: string }; amount: number; status: string; remaining: number }[];
      }>(response);

      expect(result).toMatchObject({ month: '2026-09', created: 2, skipped: 0 });
      expect(result.charges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            student: expect.objectContaining({ id: studentId }),
            amount: 1200,
            remaining: 1200,
            status: ChargeStatus.NotPaid,
          }),
        ]),
      );
    });

    it('повторный запуск второй строки не заводит — только считает пропущенных', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();

      await chargeMonth(token, '2026-09', groupId);
      const response = await send('post', '/api/v1/accounting/payments/charges', token, {
        month: '2026-09',
        groupId,
      }).expect(201);

      expect(dataOf<{ created: number; skipped: number }>(response)).toEqual(
        expect.objectContaining({ created: 0, skipped: 1 }),
      );
      expect(store.chargeCount()).toBe(1);
    });

    it('соседний месяц начисляется отдельной строкой', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();

      await chargeMonth(token, '2026-09', groupId);
      await chargeMonth(token, '2026-10', groupId);

      expect(store.chargeCount()).toBe(2);
    });

    it('отменённой группе месяц не начисляется — 422', async () => {
      const token = await cashier();
      const groupId = store.addGroup({ status: GroupStatus.CANCELLED });
      store.enroll(groupId, store.addStudent());

      await send('post', '/api/v1/accounting/payments/charges', token, {
        month: '2026-09',
        groupId,
      }).expect(422);
      expect(store.chargeCount()).toBe(0);
    });

    it('без `groupId` начисляются все группы, кроме отменённых', async () => {
      const token = await cashier();
      seedGroup();
      const cancelled = store.addGroup({ status: GroupStatus.CANCELLED });
      store.enroll(cancelled, store.addStudent());

      const response = await send('post', '/api/v1/accounting/payments/charges', token, {
        month: '2026-09',
      }).expect(201);

      expect(dataOf<{ created: number }>(response).created).toBe(1);
    });

    it('400 на негодный месяц — ничего не заводится', async () => {
      const token = await cashier();
      seedGroup();

      await send('post', '/api/v1/accounting/payments/charges', token, {
        month: '2026-13',
      }).expect(400);
      await send('post', '/api/v1/accounting/payments/charges', token, {
        month: '2026-09-01',
      }).expect(400);
      expect(store.chargeCount()).toBe(0);
    });
  });

  describe('Приём оплаты', () => {
    it('частичная оплата переводит месяц в PARTIAL, полная — в PAID', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);

      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: 500,
      }).expect(201);

      const partial = dataOf<{ status: string; paid: number; remaining: number }>(
        await get(`/api/v1/accounting/payments/${charge.id}`, token).expect(200),
      );
      expect(partial).toMatchObject({ status: ChargeStatus.Partial, paid: 500, remaining: 700 });

      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: 700,
      }).expect(201);

      const paid = dataOf<{ status: string; remaining: number }>(
        await get(`/api/v1/accounting/payments/${charge.id}`, token).expect(200),
      );
      expect(paid).toMatchObject({ status: ChargeStatus.Paid, remaining: 0 });
    });

    it('422 на сумму больше остатка — переплата оформляется предоплатой', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);

      const response = await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: 1500,
      }).expect(422);

      expect(JSON.stringify(response.body)).toContain('предоплатой');
      expect(store.transactionCount()).toBe(0);
    });

    it('422 на закрытый месяц', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);

      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: 1200,
      }).expect(201);
      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: 100,
      }).expect(422);
    });

    it('422 на несуществующее начисление', async () => {
      const token = await cashier();

      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: randomUUID(),
        amount: 100,
      }).expect(422);
    });

    it('400 на нулевую и отрицательную сумму — списания в кассе нет', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);

      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: 0,
      }).expect(400);
      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: -100,
      }).expect(400);
      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: 10.005,
      }).expect(400);
      expect(store.transactionCount()).toBe(0);
    });

    it('копейки не теряются: 399.99 остаётся 399.99', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);

      const response = await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: 399.99,
      }).expect(201);

      expect(dataOf<{ amount: number }>(response).amount).toBe(399.99);
      expect(store.storedRemaining(charge.id)).toBe(800.01);
    });
  });

  describe('Скидка на месяц', () => {
    it('скидка уменьшает остаток и меняет статус', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);

      const response = await send('put', `/api/v1/accounting/payments/${charge.id}`, token, {
        discount: 1200,
        discountReason: 'Стипендия центра',
      }).expect(200);

      expect(dataOf<{ due: number; remaining: number; status: string }>(response)).toMatchObject({
        due: 0,
        remaining: 0,
        status: ChargeStatus.Paid,
      });
    });

    it('400 на скидку без причины и на скидку больше начисленного', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);

      await send('put', `/api/v1/accounting/payments/${charge.id}`, token, {
        discount: 200,
      }).expect(400);
      await send('put', `/api/v1/accounting/payments/${charge.id}`, token, {
        discount: 5000,
        discountReason: 'Ошибка',
      }).expect(400);
      expect(store.storedRemaining(charge.id)).toBe(1200);
    });

    it('422 на скидку ниже уже принятых денег', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);

      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: 1000,
      }).expect(201);
      await send('put', `/api/v1/accounting/payments/${charge.id}`, token, {
        discount: 500,
        discountReason: 'Пересчёт',
      }).expect(422);
    });
  });

  describe('Предоплата', () => {
    it('заводится без месяца и в витрине должников стоит отдельной колонкой', async () => {
      const token = await cashier();
      const { groupId, studentId } = seedGroup();
      await chargeMonth(token, '2026-09', groupId);

      const response = await send('post', '/api/v1/accounting/payments/prepayment', token, {
        studentId,
        amount: 500,
      }).expect(201);

      expect(dataOf<{ prepayment: boolean; charge: null }>(response)).toMatchObject({
        prepayment: true,
        charge: null,
      });

      const debtors = dataOf<{ debt: number; prepaid: number }[]>(
        await get('/api/v1/accounting/debtors', token).expect(200),
      );
      // Деньги приняты, но месяц ими не закрыт: долг остаётся полным.
      expect(debtors[0]).toMatchObject({ debt: 1200, prepaid: 500 });
    });

    it('разнесение предоплаты закрывает месяц', async () => {
      const token = await cashier();
      const { groupId, studentId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);

      const prepayment = dataOf<{ id: string }>(
        await send('post', '/api/v1/accounting/payments/prepayment', token, {
          studentId,
          amount: 1200,
        }).expect(201),
      );

      await send('put', `/api/v1/accounting/payments/transactions/${prepayment.id}`, token, {
        reason: 'Разнесена предоплата за сентябрь',
        chargeId: charge.id,
      }).expect(200);

      expect(store.storedRemaining(charge.id)).toBe(0);
      const debtors = dataOf<unknown[]>(await get('/api/v1/accounting/debtors', token).expect(200));
      expect(debtors).toEqual([]);
    });

    it('пустая строка возвращает платёж в предоплату, и долг появляется снова', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);

      const payment = dataOf<{ id: string }>(
        await send('post', '/api/v1/accounting/payments', token, {
          chargeId: charge.id,
          amount: 1200,
        }).expect(201),
      );

      const response = await send(
        'put',
        `/api/v1/accounting/payments/transactions/${payment.id}`,
        token,
        { reason: 'Разнесено по ошибке', chargeId: '' },
      ).expect(200);

      expect(dataOf<{ prepayment: boolean }>(response).prepayment).toBe(true);
      expect(store.storedRemaining(charge.id)).toBe(1200);
    });

    it('422 на разнесение в месяц другого студента', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);
      const stranger = store.addStudent({ lastName: 'Иброхимов' });

      const prepayment = dataOf<{ id: string }>(
        await send('post', '/api/v1/accounting/payments/prepayment', token, {
          studentId: stranger,
          amount: 500,
        }).expect(201),
      );

      await send('put', `/api/v1/accounting/payments/transactions/${prepayment.id}`, token, {
        reason: 'Разнесение',
        chargeId: charge.id,
      }).expect(422);
      expect(store.storedRemaining(charge.id)).toBe(1200);
    });

    it('422 на несуществующего студента — предоплата не заводится', async () => {
      const token = await cashier();

      await send('post', '/api/v1/accounting/payments/prepayment', token, {
        studentId: randomUUID(),
        amount: 500,
      }).expect(422);
      expect(store.transactionCount()).toBe(0);
    });
  });

  describe('Правка и отмена платежа', () => {
    it('правка требует причины и сохраняет её в строке', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);
      const payment = dataOf<{ id: string }>(
        await send('post', '/api/v1/accounting/payments', token, {
          chargeId: charge.id,
          amount: 600,
        }).expect(201),
      );

      await send('put', `/api/v1/accounting/payments/transactions/${payment.id}`, token, {
        amount: 400,
      }).expect(400);

      const response = await send(
        'put',
        `/api/v1/accounting/payments/transactions/${payment.id}`,
        token,
        { amount: 400, reason: 'В чеке 400, а не 600' },
      ).expect(200);

      expect(dataOf<{ amount: number; edit: { reason: string } }>(response)).toMatchObject({
        amount: 400,
        edit: expect.objectContaining({ reason: 'В чеке 400, а не 600' }),
      });
      expect(store.storedRemaining(charge.id)).toBe(800);
    });

    it('отмена платежа возвращает месяц в NOT_PAID', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);
      const payment = dataOf<{ id: string }>(
        await send('post', '/api/v1/accounting/payments', token, {
          chargeId: charge.id,
          amount: 1200,
        }).expect(201),
      );

      await send('delete', `/api/v1/accounting/payments/transactions/${payment.id}`, token, {
        reason: 'Деньги записаны не тому студенту',
      }).expect(200);

      const after = dataOf<{ status: string; remaining: number }>(
        await get(`/api/v1/accounting/payments/${charge.id}`, token).expect(200),
      );
      expect(after).toMatchObject({ status: ChargeStatus.NotPaid, remaining: 1200 });
    });

    it('404 на неизвестный платёж', async () => {
      const token = await cashier();

      await send('delete', `/api/v1/accounting/payments/transactions/${randomUUID()}`, token, {
        reason: 'Ошибка',
      }).expect(404);
    });
  });

  describe('Удаление начисления', () => {
    it('409 на месяц с платежами → отменил платёж → месяц удаляется', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);
      const payment = dataOf<{ id: string }>(
        await send('post', '/api/v1/accounting/payments', token, {
          chargeId: charge.id,
          amount: 600,
        }).expect(201),
      );

      await send('delete', `/api/v1/accounting/payments/${charge.id}`, token, {
        reason: 'Ошибочное начисление',
      }).expect(409);

      await send('delete', `/api/v1/accounting/payments/transactions/${payment.id}`, token, {
        reason: 'Ошибка кассы',
      }).expect(200);
      await send('delete', `/api/v1/accounting/payments/${charge.id}`, token, {
        reason: 'Ошибочное начисление',
      }).expect(200);

      expect(store.chargeCount()).toBe(0);
    });

    it('400 на удаление без причины', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);

      await send('delete', `/api/v1/accounting/payments/${charge.id}`, token, {}).expect(400);
      expect(store.chargeCount()).toBe(1);
    });
  });

  describe('Список начислений и итоги', () => {
    it('итоги считаются по всему набору, а не по странице', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      store.enroll(groupId, store.addStudent({ lastName: 'Раҳимов' }));
      const [first] = [await chargeMonth(token, '2026-09', groupId)];

      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: first.id,
        amount: 200,
      }).expect(201);

      const response = await get('/api/v1/accounting/payments?limit=1', token).expect(200);

      expect(dataOf<unknown[]>(response)).toHaveLength(1);
      expect(metaOf<{ total: number; totals: unknown }>(response)).toMatchObject({
        total: 2,
        totals: { charged: 2400, paid: 200, debt: 2200 },
      });
    });

    it('фильтр по статусу отбирает неоплаченные месяцы', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      store.enroll(groupId, store.addStudent({ lastName: 'Раҳимов' }));
      const charge = await chargeMonth(token, '2026-09', groupId);

      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: 1200,
      }).expect(201);

      const notPaid = dataOf<{ id: string }[]>(
        await get(`/api/v1/accounting/payments?status=${ChargeStatus.NotPaid}`, token).expect(200),
      );
      const paid = dataOf<{ id: string }[]>(
        await get(`/api/v1/accounting/payments?status=${ChargeStatus.Paid}`, token).expect(200),
      );

      expect(notPaid).toHaveLength(1);
      expect(paid).toEqual([expect.objectContaining({ id: charge.id })]);
    });

    it('период задаётся месяцами включительно', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      await chargeMonth(token, '2026-08', groupId);
      await chargeMonth(token, '2026-09', groupId);
      await chargeMonth(token, '2026-10', groupId);

      const rows = dataOf<{ month: string }[]>(
        await get('/api/v1/accounting/payments?from=2026-09&to=2026-10', token).expect(200),
      );

      expect(rows.map(({ month }) => month).sort()).toEqual(['2026-09', '2026-10']);
    });

    it('карточка месяца отдаёт платежи, которые его закрывают', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);

      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: 600,
      }).expect(201);

      const card = dataOf<{ transactions: { amount: number }[] }>(
        await get(`/api/v1/accounting/payments/${charge.id}`, token).expect(200),
      );

      expect(card.transactions).toEqual([expect.objectContaining({ amount: 600 })]);
    });

    it('404 на неизвестное начисление и 400 на не-UUID в пути', async () => {
      const token = await viewer();

      await get(`/api/v1/accounting/payments/${randomUUID()}`, token).expect(404);
      await get('/api/v1/accounting/payments/не-uuid', token).expect(400);
    });

    it('`transactions` не путается с карточкой начисления', async () => {
      // Маршрут объявлен выше `:id`; иначе `ParseUUIDPipe` ответил бы 400
      // на существующий эндпоинт (ловушка сессии 0028).
      const token = await viewer();

      await get('/api/v1/accounting/payments/transactions', token).expect(200);
    });
  });

  describe('История платежей', () => {
    it('фильтр `prepayment` разводит предоплаты и разнесённые платежи', async () => {
      const token = await cashier();
      const { groupId, studentId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);

      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: 600,
      }).expect(201);
      await send('post', '/api/v1/accounting/payments/prepayment', token, {
        studentId,
        amount: 300,
      }).expect(201);

      const prepayments = dataOf<{ prepayment: boolean }[]>(
        await get('/api/v1/accounting/payments/transactions?prepayment=true', token).expect(200),
      );
      const assigned = dataOf<{ prepayment: boolean }[]>(
        await get('/api/v1/accounting/payments/transactions?prepayment=false', token).expect(200),
      );

      expect(prepayments).toEqual([expect.objectContaining({ prepayment: true, amount: 300 })]);
      expect(assigned).toEqual([expect.objectContaining({ prepayment: false, amount: 600 })]);
    });

    it('сумма отобранных платежей уходит в `meta.totalAmount`', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);

      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: 600,
      }).expect(201);

      const response = await get('/api/v1/accounting/payments/transactions', token).expect(200);

      expect(metaOf<{ totalAmount: number }>(response).totalAmount).toBe(600);
    });
  });

  describe('Должники', () => {
    it('список отсортирован по убыванию долга, итоги — в `meta`', async () => {
      const token = await cashier();
      const poor = store.addGroup({ name: 'Frontend-1', feeCents: 120000 });
      const rich = store.addGroup({ name: 'Backend-1', feeCents: 300000 });
      store.enroll(poor, store.addStudent({ lastName: 'Каримова' }));
      store.enroll(rich, store.addStudent({ lastName: 'Раҳимов' }));

      await chargeMonth(token, '2026-09', poor);
      await chargeMonth(token, '2026-09', rich);

      const response = await get('/api/v1/accounting/debtors', token).expect(200);
      const rows = dataOf<{ student: { lastName: string }; debt: number }[]>(response);

      expect(rows.map(({ debt }) => debt)).toEqual([3000, 1200]);
      expect(metaOf<{ totals: unknown }>(response)).toMatchObject({
        totals: { students: 2, debt: 4200 },
      });
    });

    it('рассчитавшийся студент из витрины пропадает', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);

      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: 1200,
      }).expect(201);

      expect(dataOf<unknown[]>(await get('/api/v1/accounting/debtors', token).expect(200))).toEqual(
        [],
      );
    });

    it('в строке видно число незакрытых месяцев и самый ранний из них', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      await chargeMonth(token, '2026-08', groupId);
      await chargeMonth(token, '2026-09', groupId);

      const rows = dataOf<{ unpaidMonths: number; oldestUnpaidMonth: string; debt: number }[]>(
        await get('/api/v1/accounting/debtors', token).expect(200),
      );

      expect(rows[0]).toMatchObject({
        unpaidMonths: 2,
        oldestUnpaidMonth: '2026-08',
        debt: 2400,
      });
    });

    it('фильтр по группе сужает долг', async () => {
      const token = await cashier();
      const { groupId, studentId } = seedGroup();
      const second = store.addGroup({ name: 'English-1', feeCents: 60000 });
      store.enroll(second, studentId);

      await chargeMonth(token, '2026-09', groupId);
      await chargeMonth(token, '2026-09', second);

      const rows = dataOf<{ debt: number }[]>(
        await get(`/api/v1/accounting/debtors?groupId=${second}`, token).expect(200),
      );

      expect(rows[0]).toMatchObject({ debt: 600 });
    });
  });

  describe('Способы оплаты', () => {
    it('заводится, принимается в платеже и не удаляется после использования', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);

      const type = dataOf<{ id: string }>(
        await send('post', '/api/v1/accounting/payment-types', token, { name: 'Alif' }).expect(201),
      );

      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: 600,
        typeId: type.id,
      }).expect(201);

      await send('delete', `/api/v1/accounting/payment-types/${type.id}`, token).expect(409);
    });

    it('409 на тёзку без учёта регистра', async () => {
      const token = await cashier();

      await send('post', '/api/v1/accounting/payment-types', token, { name: 'Наличные' }).expect(
        201,
      );
      await send('post', '/api/v1/accounting/payment-types', token, { name: 'наличные' }).expect(
        409,
      );
    });

    it('выведенный из работы способ новым платежам не проставляется — 422', async () => {
      const token = await cashier();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);
      const typeId = store.seedType({ name: 'Старый терминал', status: DirectoryStatus.INACTIVE });

      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: 600,
        typeId,
      }).expect(422);
      expect(store.transactionCount()).toBe(0);
    });

    it('способ без платежей удаляется', async () => {
      const token = await cashier();
      const type = dataOf<{ id: string }>(
        await send('post', '/api/v1/accounting/payment-types', token, {
          name: 'Душанбе Сити',
        }).expect(201),
      );

      await send('delete', `/api/v1/accounting/payment-types/${type.id}`, token).expect(200);
      await get(`/api/v1/accounting/payment-types/${type.id}`, token).expect(404);
    });
  });

  describe('Категории расходов (ТЗ 5.16)', () => {
    it('отдаёт справочник деревом: подкатегории внутри родителя', async () => {
      const token = await viewer();
      const taxId = store.seedCategory({ name: 'Налоги' });
      store.seedCategory({ name: 'НДС', parentId: taxId });
      store.seedCategory({ name: 'Офис' });

      const catalog = dataOf<{
        total: number;
        categories: { name: string; children: { name: string }[] }[];
      }>(await get('/api/v1/accounting/expense-categories', token).expect(200));

      expect(catalog.total).toBe(3);
      expect(catalog.categories.map(({ name }) => name)).toEqual(['Налоги', 'Офис']);
      expect(catalog.categories[0].children.map(({ name }) => name)).toEqual(['НДС']);
    });

    it('заводится подкатегория, а третий уровень отклоняется — 422', async () => {
      const token = await accountant();
      const tax = dataOf<{ id: string }>(
        await send('post', '/api/v1/accounting/expense-categories', token, {
          name: 'Налоги',
        }).expect(201),
      );

      const vat = dataOf<{ id: string; parent: { name: string } | null }>(
        await send('post', '/api/v1/accounting/expense-categories', token, {
          name: 'НДС',
          parentId: tax.id,
        }).expect(201),
      );
      expect(vat.parent).toMatchObject({ name: 'Налоги' });

      await send('post', '/api/v1/accounting/expense-categories', token, {
        name: 'НДС 5%',
        parentId: vat.id,
      }).expect(422);
    });

    it('409 на тёзку без учёта регистра', async () => {
      const token = await accountant();

      await send('post', '/api/v1/accounting/expense-categories', token, {
        name: 'Маркетинг',
      }).expect(201);
      await send('post', '/api/v1/accounting/expense-categories', token, {
        name: 'маркетинг',
      }).expect(409);
    });

    it('пустой `parentId` поднимает категорию на верхний уровень', async () => {
      const token = await accountant();
      const taxId = store.seedCategory({ name: 'Налоги' });
      const vatId = store.seedCategory({ name: 'НДС', parentId: taxId });

      const updated = dataOf<{ parent: unknown }>(
        await send('put', `/api/v1/accounting/expense-categories/${vatId}`, token, {
          parentId: '',
        }).expect(200),
      );

      expect(updated.parent).toBeNull();
    });

    it('категория с расходами не удаляется — 409', async () => {
      const token = await accountant();
      const categoryId = store.seedCategory({ name: 'Офис' });

      await send('post', '/api/v1/accounting/expenses', token, {
        categoryId,
        title: 'Аренда офиса за сентябрь',
        amount: 4500,
        spentAt: '2026-09-05',
      }).expect(201);

      await send('delete', `/api/v1/accounting/expense-categories/${categoryId}`, token).expect(
        409,
      );
    });

    it('категория с подкатегориями не удаляется — 409', async () => {
      const token = await accountant();
      const taxId = store.seedCategory({ name: 'Налоги' });
      store.seedCategory({ name: 'НДС', parentId: taxId });

      await send('delete', `/api/v1/accounting/expense-categories/${taxId}`, token).expect(409);
    });

    it('неиспользованная категория удаляется', async () => {
      const token = await accountant();
      const categoryId = store.seedCategory({ name: 'Транспорт' });

      await send('delete', `/api/v1/accounting/expense-categories/${categoryId}`, token).expect(
        200,
      );
      await get(`/api/v1/accounting/expense-categories/${categoryId}`, token).expect(404);
    });
  });

  describe('Расходы (ТЗ 5.16)', () => {
    it('проводится расход, сумма набора приходит в `meta.totals`', async () => {
      const token = await accountant();
      const categoryId = store.seedCategory({ name: 'Офис' });

      const expense = dataOf<{ amount: number; spentAt: string; branch: unknown }>(
        await send('post', '/api/v1/accounting/expenses', token, {
          categoryId,
          title: 'Аренда офиса за сентябрь',
          amount: 4500.5,
          spentAt: '2026-09-05',
        }).expect(201),
      );

      expect(expense).toMatchObject({ amount: 4500.5, spentAt: '2026-09-05', branch: null });

      const totals = metaOf<{ totals: { amount: number } }>(
        await get('/api/v1/accounting/expenses', token).expect(200),
      );
      expect(totals.totals.amount).toBe(4500.5);
    });

    it('копейки не теряются на сумме расходов', async () => {
      const token = await accountant();
      const categoryId = store.seedCategory({ name: 'Офис' });

      for (const amount of [33.33, 33.33, 33.33]) {
        await send('post', '/api/v1/accounting/expenses', token, {
          categoryId,
          title: 'Хозяйственные расходы',
          amount,
          spentAt: '2026-09-05',
        }).expect(201);
      }

      const totals = metaOf<{ totals: { amount: number } }>(
        await get('/api/v1/accounting/expenses', token).expect(200),
      );
      expect(totals.totals.amount).toBe(99.99);
    });

    it('фильтр по разделу показывает и его подкатегории', async () => {
      const token = await accountant();
      const taxId = store.seedCategory({ name: 'Налоги' });
      const vatId = store.seedCategory({ name: 'НДС', parentId: taxId });
      const officeId = store.seedCategory({ name: 'Офис' });

      await send('post', '/api/v1/accounting/expenses', token, {
        categoryId: vatId,
        title: 'НДС за сентябрь',
        amount: 1200,
        spentAt: '2026-09-20',
      }).expect(201);
      await send('post', '/api/v1/accounting/expenses', token, {
        categoryId: officeId,
        title: 'Аренда',
        amount: 4500,
        spentAt: '2026-09-05',
      }).expect(201);

      const rows = dataOf<{ title: string }[]>(
        await get(`/api/v1/accounting/expenses?categoryId=${taxId}`, token).expect(200),
      );

      expect(rows.map(({ title }) => title)).toEqual(['НДС за сентябрь']);
    });

    it('период отбирает расходы месяцами', async () => {
      const token = await accountant();
      const categoryId = store.seedCategory({ name: 'Офис' });

      for (const spentAt of ['2026-08-31', '2026-09-01', '2026-10-01']) {
        await send('post', '/api/v1/accounting/expenses', token, {
          categoryId,
          title: `Аренда ${spentAt}`,
          amount: 100,
          spentAt,
        }).expect(201);
      }

      const rows = dataOf<{ spentAt: string }[]>(
        await get('/api/v1/accounting/expenses?from=2026-09&to=2026-09', token).expect(200),
      );

      expect(rows.map(({ spentAt }) => spentAt)).toEqual(['2026-09-01']);
    });

    it('422 на выведенную из работы категорию — расход не заводится', async () => {
      const token = await accountant();
      const categoryId = store.seedCategory({
        name: 'Старая статья',
        status: DirectoryStatus.INACTIVE,
      });

      await send('post', '/api/v1/accounting/expenses', token, {
        categoryId,
        title: 'Аренда офиса',
        amount: 100,
      }).expect(422);
      expect(store.expenseCount()).toBe(0);
    });

    it('422 на несуществующий филиал', async () => {
      const token = await accountant();
      const categoryId = store.seedCategory({ name: 'Офис' });

      await send('post', '/api/v1/accounting/expenses', token, {
        categoryId,
        title: 'Аренда офиса',
        amount: 100,
        branchId: randomUUID(),
      }).expect(422);
      expect(store.expenseCount()).toBe(0);
    });

    it('расход относится на филиал, а пустая строка делает его общим', async () => {
      const token = await accountant();
      const categoryId = store.seedCategory({ name: 'Офис' });
      const branchId = store.seedBranch('Profsous');

      const expense = dataOf<{ id: string; branch: { name: string } | null }>(
        await send('post', '/api/v1/accounting/expenses', token, {
          categoryId,
          title: 'Аренда офиса',
          amount: 100,
          branchId,
        }).expect(201),
      );
      expect(expense.branch).toMatchObject({ name: 'Profsous' });

      const updated = dataOf<{ branch: unknown }>(
        await send('put', `/api/v1/accounting/expenses/${expense.id}`, token, {
          branchId: '',
        }).expect(200),
      );
      expect(updated.branch).toBeNull();
    });

    it('удаление требует причины и убирает расход из отчёта', async () => {
      const token = await accountant();
      const categoryId = store.seedCategory({ name: 'Офис' });
      const expense = dataOf<{ id: string }>(
        await send('post', '/api/v1/accounting/expenses', token, {
          categoryId,
          title: 'Аренда офиса',
          amount: 4500,
        }).expect(201),
      );

      await send('delete', `/api/v1/accounting/expenses/${expense.id}`, token, {}).expect(400);
      await send('delete', `/api/v1/accounting/expenses/${expense.id}`, token, {
        reason: 'Проведён дважды',
      }).expect(200);

      expect(store.expenseCount()).toBe(0);
    });

    it('право на просмотр не даёт проводить расходы — 403', async () => {
      const token = await viewer();
      const categoryId = store.seedCategory({ name: 'Офис' });

      await get('/api/v1/accounting/expenses', token).expect(200);
      await send('post', '/api/v1/accounting/expenses', token, {
        categoryId,
        title: 'Аренда офиса',
        amount: 100,
      }).expect(403);
    });

    it('право на оплаты бухгалтерию расходов не открывает — 403', async () => {
      const token = await cashier();
      const categoryId = store.seedCategory({ name: 'Офис' });

      await send('post', '/api/v1/accounting/expenses', token, {
        categoryId,
        title: 'Аренда офиса',
        amount: 100,
      }).expect(403);
    });
  });

  describe('Бюджет (ТЗ 5.16)', () => {
    /** Расход настоящим маршрутом — иначе `spent` считался бы по подставленным данным. */
    const spend = async (
      token: string,
      categoryId: string,
      amount: number,
      spentAt: string,
    ): Promise<void> => {
      await send('post', '/api/v1/accounting/expenses', token, {
        categoryId,
        title: 'Расход',
        amount,
        spentAt,
      }).expect(201);
    };

    it('план заводится со строками, `spent` считается по расходам периода', async () => {
      // Главное свойство раздела: потраченное нигде не хранится — оно берётся
      // из тех же расходов, что видит «Income vs Expense» обзора.
      const token = await actor([
        'Permission.Accounting.Views',
        'Permission.Accounting.ManageBudget',
        'Permission.Accounting.ManageExpenses',
      ]);
      const officeId = store.seedCategory({ name: 'Офис' });
      const marketingId = store.seedCategory({ name: 'Маркетинг' });

      await spend(token.token, officeId, 15_100, '2026-02-10');
      await spend(token.token, marketingId, 3250, '2026-03-01');

      const card = dataOf<{
        id: string;
        lines: {
          category: { name: string };
          allocated: number;
          spent: number;
          overspent: boolean;
        }[];
        totals: { allocated: number; spent: number; remaining: number };
      }>(
        await send('post', '/api/v1/accounting/budget', token.token, {
          name: 'Бюджет на I квартал 2026',
          periodFrom: '2026-01',
          periodTo: '2026-03',
          status: 'ACTIVE',
          lines: [
            { categoryId: officeId, allocated: 12_000 },
            { categoryId: marketingId, allocated: 8000 },
          ],
        }).expect(201),
      );

      expect(card.totals).toMatchObject({ allocated: 20_000, spent: 18_350, remaining: 1650 });
      expect(card.lines.map((line) => line.category.name)).toEqual(['Офис', 'Маркетинг']);
      expect(card.lines[0]).toMatchObject({ allocated: 12_000, spent: 15_100, overspent: true });
    });

    it('расход вне периода плана в `spent` не попадает', async () => {
      const token = await actor([
        'Permission.Accounting.Views',
        'Permission.Accounting.ManageBudget',
        'Permission.Accounting.ManageExpenses',
      ]);
      const officeId = store.seedCategory({ name: 'Офис' });

      // 31 декабря и 1 апреля — снаружи периода «январь…март».
      await spend(token.token, officeId, 100, '2025-12-31');
      await spend(token.token, officeId, 500, '2026-02-10');
      await spend(token.token, officeId, 900, '2026-04-01');

      const card = dataOf<{ totals: { spent: number } }>(
        await send('post', '/api/v1/accounting/budget', token.token, {
          name: 'Квартал',
          periodFrom: '2026-01',
          periodTo: '2026-03',
          lines: [{ categoryId: officeId, allocated: 1000 }],
        }).expect(201),
      );

      expect(card.totals.spent).toBe(500);
    });

    it('план по разделу собирает расходы его подстатей', async () => {
      // Ровно то, ради чего справочник статей сделан двухуровневым (0030).
      const token = await actor([
        'Permission.Accounting.Views',
        'Permission.Accounting.ManageBudget',
        'Permission.Accounting.ManageExpenses',
      ]);
      const taxId = store.seedCategory({ name: 'Налоги' });
      const vatId = store.seedCategory({ name: 'НДС', parentId: taxId });
      const incomeTaxId = store.seedCategory({ name: 'Подоходный', parentId: taxId });

      await spend(token.token, vatId, 8000, '2026-02-10');
      await spend(token.token, incomeTaxId, 5000, '2026-02-11');

      const card = dataOf<{ lines: { spent: number; usage: number }[] }>(
        await send('post', '/api/v1/accounting/budget', token.token, {
          name: 'Налоговый план',
          periodFrom: '2026-01',
          periodTo: '2026-03',
          lines: [{ categoryId: taxId, allocated: 26_000 }],
        }).expect(201),
      );

      expect(card.lines[0]).toMatchObject({ spent: 13_000, usage: 50 });
    });

    it('422 на раздел и его подстатью в одном плане — план не заведён', async () => {
      const token = await planner();
      const taxId = store.seedCategory({ name: 'Налоги' });
      const vatId = store.seedCategory({ name: 'НДС', parentId: taxId });

      await send('post', '/api/v1/accounting/budget', token, {
        name: 'Двойной счёт',
        periodFrom: '2026-01',
        periodTo: '2026-03',
        lines: [
          { categoryId: taxId, allocated: 30_000 },
          { categoryId: vatId, allocated: 8000 },
        ],
      }).expect(422);

      expect(store.budgetCount()).toBe(0);
    });

    it('строки заменяются целиком, пустой список очищает план', async () => {
      const token = await planner();
      const officeId = store.seedCategory({ name: 'Офис' });
      const marketingId = store.seedCategory({ name: 'Маркетинг' });

      const { id } = dataOf<{ id: string }>(
        await send('post', '/api/v1/accounting/budget', token, {
          name: 'План',
          periodFrom: '2026-01',
          periodTo: '2026-03',
          lines: [{ categoryId: officeId, allocated: 100 }],
        }).expect(201),
      );

      const replaced = dataOf<{ lines: { category: { id: string } }[] }>(
        await send('put', `/api/v1/accounting/budget/${id}`, token, {
          lines: [{ categoryId: marketingId, allocated: 200 }],
        }).expect(200),
      );
      expect(replaced.lines.map((line) => line.category.id)).toEqual([marketingId]);

      // Не переданное поле набор не трогает.
      await send('put', `/api/v1/accounting/budget/${id}`, token, { name: 'План центра' }).expect(
        200,
      );
      expect(store.budgetLineCount(id)).toBe(1);

      const cleared = dataOf<{ lines: unknown[]; totals: { allocated: number } }>(
        await send('put', `/api/v1/accounting/budget/${id}`, token, { lines: [] }).expect(200),
      );
      expect(cleared.lines).toEqual([]);
      expect(cleared.totals.allocated).toBe(0);
    });

    it('закрытый план не правится, но возвращается в работу — и тогда правится', async () => {
      const token = await planner();
      const officeId = store.seedCategory({ name: 'Офис' });

      const { id } = dataOf<{ id: string }>(
        await send('post', '/api/v1/accounting/budget', token, {
          name: 'План',
          periodFrom: '2026-01',
          periodTo: '2026-03',
          status: 'ACTIVE',
          lines: [{ categoryId: officeId, allocated: 100 }],
        }).expect(201),
      );

      await send('put', `/api/v1/accounting/budget/${id}`, token, { status: 'CLOSED' }).expect(200);

      // Снимок принятого решения не правится и не удаляется…
      await send('put', `/api/v1/accounting/budget/${id}`, token, { name: 'Другое имя' }).expect(
        422,
      );
      await send('delete', `/api/v1/accounting/budget/${id}`, token).expect(422);
      // …и правка «заодно» с открытием тоже не проезжает.
      await send('put', `/api/v1/accounting/budget/${id}`, token, {
        status: 'ACTIVE',
        name: 'Другое имя',
      }).expect(422);

      // …но обратный ход есть, иначе ошибочное закрытие было бы необратимым.
      await send('put', `/api/v1/accounting/budget/${id}`, token, { status: 'ACTIVE' }).expect(200);
      const renamed = dataOf<{ name: string }>(
        await send('put', `/api/v1/accounting/budget/${id}`, token, { name: 'Другое имя' }).expect(
          200,
        ),
      );
      expect(renamed.name).toBe('Другое имя');
    });

    it('статью, запланированную в бюджете, удалить нельзя (409) → убрали из плана → удалилась', async () => {
      const token = await actor([
        'Permission.Accounting.Views',
        'Permission.Accounting.ManageBudget',
        'Permission.Accounting.ManageExpenses',
      ]);
      const officeId = store.seedCategory({ name: 'Офис' });

      const { id } = dataOf<{ id: string }>(
        await send('post', '/api/v1/accounting/budget', token.token, {
          name: 'План',
          periodFrom: '2026-01',
          periodTo: '2026-03',
          lines: [{ categoryId: officeId, allocated: 100 }],
        }).expect(201),
      );

      await send('delete', `/api/v1/accounting/expense-categories/${officeId}`, token.token).expect(
        409,
      );

      await send('put', `/api/v1/accounting/budget/${id}`, token.token, { lines: [] }).expect(200);
      await send('delete', `/api/v1/accounting/expense-categories/${officeId}`, token.token).expect(
        200,
      );
    });

    it('периоды разных бюджетов пересекаются — фильтр отбирает по пересечению', async () => {
      const token = await planner();

      for (const [name, from, to] of [
        ['Год 2026', '2026-01', '2026-12'],
        ['Кампания марта', '2026-03', '2026-03'],
        ['Год 2025', '2025-01', '2025-12'],
      ]) {
        await send('post', '/api/v1/accounting/budget', token, {
          name,
          periodFrom: from,
          periodTo: to,
        }).expect(201);
      }

      const response = await get('/api/v1/accounting/budget?from=2026-03&to=2026-03', token).expect(
        200,
      );
      const names = dataOf<{ name: string }[]>(response).map((row) => row.name);

      expect(names).toEqual(expect.arrayContaining(['Год 2026', 'Кампания марта']));
      expect(names).not.toContain('Год 2025');
    });

    it('фильтр по статье показывает планы, где она есть', async () => {
      const token = await planner();
      const officeId = store.seedCategory({ name: 'Офис' });
      const marketingId = store.seedCategory({ name: 'Маркетинг' });

      await send('post', '/api/v1/accounting/budget', token, {
        name: 'Офисный план',
        periodFrom: '2026-01',
        periodTo: '2026-03',
        lines: [{ categoryId: officeId, allocated: 100 }],
      }).expect(201);
      await send('post', '/api/v1/accounting/budget', token, {
        name: 'Маркетинговый план',
        periodFrom: '2026-01',
        periodTo: '2026-03',
        lines: [{ categoryId: marketingId, allocated: 200 }],
      }).expect(201);

      const rows = dataOf<{ name: string }[]>(
        await get(`/api/v1/accounting/budget?categoryId=${officeId}`, token).expect(200),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Офисный план');
    });

    it('нулевой план допустим, освоения у него нет', async () => {
      const token = await planner();
      const officeId = store.seedCategory({ name: 'Офис' });

      const card = dataOf<{ lines: { allocated: number; usage: number | null }[] }>(
        await send('post', '/api/v1/accounting/budget', token, {
          name: 'Запрет тратить',
          periodFrom: '2026-01',
          periodTo: '2026-03',
          lines: [{ categoryId: officeId, allocated: 0 }],
        }).expect(201),
      );

      expect(card.lines[0]).toMatchObject({ allocated: 0, usage: null });
    });

    it('409 на тёзку без учёта регистра, 400 на перевёрнутый и слишком длинный период', async () => {
      const token = await planner();

      await send('post', '/api/v1/accounting/budget', token, {
        name: 'Бюджет центра',
        periodFrom: '2026-01',
        periodTo: '2026-03',
      }).expect(201);

      await send('post', '/api/v1/accounting/budget', token, {
        name: 'бюджет ЦЕНТРА',
        periodFrom: '2026-01',
        periodTo: '2026-03',
      }).expect(409);

      await send('post', '/api/v1/accounting/budget', token, {
        name: 'Наоборот',
        periodFrom: '2026-03',
        periodTo: '2026-01',
      }).expect(400);

      await send('post', '/api/v1/accounting/budget', token, {
        name: 'Слишком длинный',
        periodFrom: '2026-01',
        periodTo: '2031-02',
      }).expect(400);

      expect(store.budgetCount()).toBe(1);
    });

    it.each([
      ['несуществующий месяц', { name: 'План', periodFrom: '2026-13', periodTo: '2026-03' }, 400],
      ['короткое название', { name: 'До', periodFrom: '2026-01', periodTo: '2026-03' }, 400],
      ['без периода', { name: 'План без периода' }, 400],
      [
        'лишнее поле',
        { name: 'План', periodFrom: '2026-01', periodTo: '2026-03', spent: 100 },
        400,
      ],
    ])('%s — %i, план не заведён', async (_case, body, status) => {
      const token = await planner();

      await send('post', '/api/v1/accounting/budget', token, body).expect(status);
      expect(store.budgetCount()).toBe(0);
    });

    it('422 на несуществующую и на выведенную из работы статью', async () => {
      const token = await planner();
      const retiredId = store.seedCategory({
        name: 'Устаревшее',
        status: DirectoryStatus.INACTIVE,
      });

      await send('post', '/api/v1/accounting/budget', token, {
        name: 'План',
        periodFrom: '2026-01',
        periodTo: '2026-03',
        lines: [{ categoryId: randomUUID(), allocated: 100 }],
      }).expect(422);

      await send('post', '/api/v1/accounting/budget', token, {
        name: 'План',
        periodFrom: '2026-01',
        periodTo: '2026-03',
        lines: [{ categoryId: retiredId, allocated: 100 }],
      }).expect(422);

      expect(store.budgetCount()).toBe(0);
    });

    it('400 на повтор статьи в плане', async () => {
      const token = await planner();
      const officeId = store.seedCategory({ name: 'Офис' });

      await send('post', '/api/v1/accounting/budget', token, {
        name: 'План',
        periodFrom: '2026-01',
        periodTo: '2026-03',
        lines: [
          { categoryId: officeId, allocated: 100 },
          { categoryId: officeId, allocated: 200 },
        ],
      }).expect(400);
    });

    it('удаляется черновик, 404 на повторное удаление и на неизвестный план', async () => {
      const token = await planner();

      const { id } = dataOf<{ id: string }>(
        await send('post', '/api/v1/accounting/budget', token, {
          name: 'Ошибочный план',
          periodFrom: '2026-01',
          periodTo: '2026-03',
        }).expect(201),
      );

      const removed = dataOf<{ name: string }>(
        await send('delete', `/api/v1/accounting/budget/${id}`, token).expect(200),
      );
      expect(removed.name).toBe('Ошибочный план');

      await send('delete', `/api/v1/accounting/budget/${id}`, token).expect(404);
      await get(`/api/v1/accounting/budget/${randomUUID()}`, token).expect(404);
      await get('/api/v1/accounting/budget/not-a-uuid', token).expect(400);
    });

    it('право на просмотр не даёт планировать, право на расходы бюджет не открывает', async () => {
      const viewerToken = await viewer();
      const expenseToken = await accountant();

      await get('/api/v1/accounting/budget', viewerToken).expect(200);
      await send('post', '/api/v1/accounting/budget', viewerToken, {
        name: 'План',
        periodFrom: '2026-01',
        periodTo: '2026-03',
      }).expect(403);

      // `ManageExpenses` про проведение денег, `ManageBudget` — про планирование.
      await send('post', '/api/v1/accounting/budget', expenseToken, {
        name: 'План',
        periodFrom: '2026-01',
        periodTo: '2026-03',
      }).expect(403);
    });

    it('401 без токена, 403 студенту и сотруднику без прав', async () => {
      await request(app.getHttpServer()).get('/api/v1/accounting/budget').expect(401);
      await get('/api/v1/accounting/budget', await studentToken()).expect(403);
      await get('/api/v1/accounting/budget', (await actor([])).token).expect(403);
    });
  });

  describe('Обзор (ТЗ 5.16)', () => {
    /** Начисленный месяц, частичная оплата и расход — один сценарий на всё. */
    const seedOverview = async (token: string): Promise<void> => {
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-09', groupId);

      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: 500,
        paidAt: '2026-09-10',
      }).expect(201);

      const categoryId = store.seedCategory({ name: 'Офис' });
      await send('post', '/api/v1/accounting/expenses', token, {
        categoryId,
        title: 'Аренда офиса',
        amount: 300,
        spentAt: '2026-09-15',
      }).expect(201);
    };

    it('сводит начисления, кассу и расходы за период', async () => {
      const token = await director();
      await seedOverview(token);

      const overview = dataOf<{
        period: { from: string; to: string; months: number };
        charges: { charged: number; paid: number; debt: number };
        income: number;
        expense: number;
        net: number;
      }>(await get('/api/v1/accounting/overview?from=2026-09&to=2026-09', token).expect(200));

      expect(overview.period).toEqual({ from: '2026-09', to: '2026-09', months: 1 });
      expect(overview.charges).toEqual({ charged: 1200, paid: 500, debt: 700 });
      expect(overview).toMatchObject({ income: 500, expense: 300, net: 200 });
    });

    it('предоплата попадает в Income, но не уменьшает долг', async () => {
      // Ровно то различие, ради которого числа разведены: касса и план.
      const token = await director();
      const { groupId, studentId } = seedGroup();
      await chargeMonth(token, '2026-09', groupId);

      await send('post', '/api/v1/accounting/payments/prepayment', token, {
        studentId,
        amount: 1000,
        paidAt: '2026-09-02',
      }).expect(201);

      const overview = dataOf<{ charges: { debt: number }; income: number; net: number }>(
        await get('/api/v1/accounting/overview?from=2026-09&to=2026-09', token).expect(200),
      );

      expect(overview.income).toBe(1000);
      expect(overview.charges.debt).toBe(1200);
      expect(overview.net).toBe(1000);
    });

    it('неоплаченный месяц увеличивает долг, но не увеличивает Income', async () => {
      const token = await director();
      const { groupId } = seedGroup();
      await chargeMonth(token, '2026-09', groupId);

      const overview = dataOf<{ charges: { debt: number }; income: number; net: number }>(
        await get('/api/v1/accounting/overview?from=2026-09&to=2026-09', token).expect(200),
      );

      expect(overview.charges.debt).toBe(1200);
      expect(overview.income).toBe(0);
      expect(overview.net).toBe(0);
    });

    it('график покрывает весь период, месяцы без операций остаются нулями', async () => {
      const token = await director();
      await seedOverview(token);

      const overview = dataOf<{ byMonth: { month: string; income: number; net: number }[] }>(
        await get('/api/v1/accounting/overview?from=2026-08&to=2026-10', token).expect(200),
      );

      expect(overview.byMonth.map(({ month }) => month)).toEqual(['2026-08', '2026-09', '2026-10']);
      expect(overview.byMonth.map(({ income }) => income)).toEqual([0, 500, 0]);
      expect(overview.byMonth[1].net).toBe(200);
    });

    it('расходы сводятся по корневым категориям с разбивкой внутри', async () => {
      const token = await director();
      const taxId = store.seedCategory({ name: 'Налоги' });
      const vatId = store.seedCategory({ name: 'НДС', parentId: taxId });

      await send('post', '/api/v1/accounting/expenses', token, {
        categoryId: vatId,
        title: 'НДС за сентябрь',
        amount: 900,
        spentAt: '2026-09-20',
      }).expect(201);

      const overview = dataOf<{
        byCategory: {
          category: { name: string };
          amount: number;
          share: number;
          children: { category: { name: string }; amount: number }[];
        }[];
      }>(await get('/api/v1/accounting/overview?from=2026-09&to=2026-09', token).expect(200));

      expect(overview.byCategory).toEqual([
        {
          category: { id: taxId, name: 'Налоги' },
          amount: 900,
          share: 100,
          children: [{ category: { id: vatId, name: 'НДС' }, amount: 900 }],
        },
      ]);
    });

    it('«Students payment по группам» считает учеников по парам, а не по месяцам', async () => {
      const token = await director();
      const { groupId } = seedGroup();
      await chargeMonth(token, '2026-08', groupId);
      await chargeMonth(token, '2026-09', groupId);

      const overview = dataOf<{
        byGroup: { group: { name: string }; students: number; charged: number; debt: number }[];
      }>(await get('/api/v1/accounting/overview?from=2026-08&to=2026-09', token).expect(200));

      expect(overview.byGroup).toHaveLength(1);
      expect(overview.byGroup[0]).toMatchObject({
        group: { id: groupId, name: 'Frontend-1' },
        students: 1,
        charged: 2400,
        debt: 2400,
      });
    });

    it('400 на обратный порядок концов и на период длиннее 60 месяцев', async () => {
      const token = await director();

      await get('/api/v1/accounting/overview?from=2026-09&to=2026-01', token).expect(400);
      await get('/api/v1/accounting/overview?from=2020-01&to=2026-01', token).expect(400);
    });

    it('по умолчанию период — последние 12 месяцев', async () => {
      const token = await director();

      const overview = dataOf<{ period: { months: number; to: string } }>(
        await get('/api/v1/accounting/overview', token).expect(200),
      );

      expect(overview.period.months).toBe(12);
      expect(overview.period.to).toBe(new Date().toISOString().slice(0, 7));
    });

    it('пустой центр отдаёт нули, а не падает', async () => {
      const token = await director();

      const overview = dataOf<{ income: number; expense: number; net: number; byGroup: [] }>(
        await get('/api/v1/accounting/overview?from=2026-09&to=2026-09', token).expect(200),
      );

      expect(overview).toMatchObject({ income: 0, expense: 0, net: 0, byGroup: [] });
    });

    it('обзор закрыт правом раздела: студенту 403, сотруднику без прав 403', async () => {
      await get('/api/v1/accounting/overview', await studentToken()).expect(403);
      await get('/api/v1/accounting/overview', (await actor([])).token).expect(403);
    });
  });

  describe('Зарплата (ТЗ 5.16)', () => {
    /** Тот, кто ведёт ведомость: планирование и расходы ему не нужны. */
    const payroll = async () =>
      (await actor(['Permission.Accounting.Views', 'Permission.Accounting.ManageSalary'])).token;

    /**
     * Ментор, который провёл занятия и получил уровень на месяц.
     * Часы приходят из журнала, ставка — из уровня месяца (решение 0032).
     */
    const seedMentor = (
      minutes: number[] = [90, 90],
      hourlyRate: number | null = 27,
      month = '2026-09',
    ): string => {
      const employeeId = store.seedEmployee();
      const groupId = store.addGroup();

      minutes.forEach((duration, index) => {
        store.seedTaughtDay(employeeId, `${month}-0${String(index + 1)}`, duration, groupId);
      });

      if (hourlyRate !== null) store.seedMonthLevel(employeeId, month, hourlyRate);

      return employeeId;
    };

    /** Сформировать ведомость настоящим маршрутом и вернуть единственную строку. */
    const sheet = async (
      token: string,
      month = '2026-09',
      employeeId?: string,
    ): Promise<{ id: string; total: number; hours: number; remaining: number }> => {
      const response = await send('post', '/api/v1/accounting/salary', token, {
        month,
        ...(employeeId === undefined ? {} : { employeeId }),
      }).expect(201);

      const { salaries } = dataOf<{
        salaries: { id: string; total: number; hours: number; remaining: number }[];
      }>(response);

      return salaries[0];
    };

    it('«часы из журнала × ставка уровня месяца» — весь путь до числа', async () => {
      const token = await payroll();
      // Два занятия по 90 минут = 3 часа, ставка 27 TJS/ч → 81 TJS.
      seedMentor([90, 90], 27);

      const row = await sheet(token);

      expect(row).toMatchObject({ hours: 3, total: 81, remaining: 81 });
    });

    it('занятие соседнего месяца в ведомость не попадает', async () => {
      const token = await payroll();
      const employeeId = seedMentor([90], 27);
      store.seedTaughtDay(employeeId, '2026-08-31', 600);
      store.seedTaughtDay(employeeId, '2026-10-01', 600);

      const row = await sheet(token);

      expect(row.hours).toBe(1.5);
    });

    it('день без записанной длительности виден нулём часов, а не пропадает', async () => {
      const token = await payroll();
      const employeeId = seedMentor([90], 27);
      store.seedTaughtDay(employeeId, '2026-09-15', null);

      const row = await sheet(token);
      const card = dataOf<{ days: { date: string; hours: number }[] }>(
        await get(`/api/v1/accounting/salary/${row.id}`, token).expect(200),
      );

      expect(row.hours).toBe(1.5);
      expect(card.days).toHaveLength(2);
      expect(card.days.find((day) => day.date === '2026-09-15')?.hours).toBe(0);
    });

    it('месяц без уровня ментора оставляет ставку null и не считает деньги', async () => {
      const token = await payroll();
      seedMentor([600], null);

      const row = await sheet(token);

      expect(row).toMatchObject({ hours: 10, total: 0 });
      expect((row as unknown as { hourlyRate: number | null }).hourlyRate).toBeNull();
    });

    it('одобренный аванс становится Prepaid и уменьшает остаток', async () => {
      const token = await payroll();
      const employeeId = seedMentor([600], 27);
      store.seedApprovedAvans(employeeId, '2026-09', 100);

      const row = await sheet(token);

      expect(row).toMatchObject({ total: 270, remaining: 170 });
      expect((row as unknown as { prepaid: number }).prepaid).toBe(100);
    });

    it('аванс человеку без часов всё равно заводит строку расчёта', async () => {
      const token = await payroll();
      const employeeId = store.seedEmployee();
      store.seedApprovedAvans(employeeId, '2026-09', 100);

      const row = await sheet(token);

      expect(row).toMatchObject({ hours: 0, total: 0, remaining: -100 });
    });

    it('повторное формирование второй строки не заводит', async () => {
      const token = await payroll();
      seedMentor();

      await sheet(token);
      const again = await send('post', '/api/v1/accounting/salary', token, {
        month: '2026-09',
      }).expect(201);

      expect(dataOf<{ created: number; skipped: number }>(again)).toMatchObject({
        created: 0,
        skipped: 1,
      });
      expect(store.salaryCount()).toBe(1);
    });

    it('премия входит в Total, часы править нечем', async () => {
      const token = await payroll();
      seedMentor([600], 27);
      const row = await sheet(token);

      const updated = dataOf<{ bonus: number; total: number }>(
        await send('put', `/api/v1/accounting/salary/${row.id}`, token, { bonus: 30 }).expect(200),
      );

      expect(updated).toMatchObject({ bonus: 30, total: 300 });
    });

    it('подтверждение замораживает расчёт: правка журнала его больше не двигает', async () => {
      const token = await payroll();
      const employeeId = seedMentor([600], 27);
      const row = await sheet(token);

      const confirmed = dataOf<{ status: string; total: number }>(
        await send('post', `/api/v1/accounting/salary/${row.id}/confirm`, token).expect(200),
      );
      expect(confirmed).toMatchObject({ status: 'DONE', total: 270 });

      // Журнал переписали задним числом — снимок обязан устоять.
      store.seedTaughtDay(employeeId, '2026-09-20', 600);
      const after = dataOf<{ total: number; hours: number }>(
        await get(`/api/v1/accounting/salary/${row.id}`, token).expect(200),
      );

      expect(after).toMatchObject({ total: 270, hours: 10 });
      expect(store.storedSalaryTotal(row.id)).toBe(270);
    });

    it('422 на подтверждение при часах без уровня месяца — расчёт остаётся черновиком', async () => {
      const token = await payroll();
      seedMentor([600], null);
      const row = await sheet(token);

      await send('post', `/api/v1/accounting/salary/${row.id}/confirm`, token).expect(422);
      expect(store.storedSalaryStatus(row.id)).toBe('DRAFT');
    });

    it('409 на повторное подтверждение', async () => {
      const token = await payroll();
      seedMentor([600], 27);
      const row = await sheet(token);

      await send('post', `/api/v1/accounting/salary/${row.id}/confirm`, token).expect(200);
      await send('post', `/api/v1/accounting/salary/${row.id}/confirm`, token).expect(409);
    });

    it('422 на правку подтверждённого → снял подтверждение → правится снова', async () => {
      const token = await payroll();
      seedMentor([600], 27);
      const row = await sheet(token);

      await send('post', `/api/v1/accounting/salary/${row.id}/confirm`, token).expect(200);
      await send('put', `/api/v1/accounting/salary/${row.id}`, token, { bonus: 50 }).expect(422);

      await send('delete', `/api/v1/accounting/salary/${row.id}/confirm`, token).expect(200);
      await send('put', `/api/v1/accounting/salary/${row.id}`, token, { bonus: 50 }).expect(200);
    });

    it('весь круг выплаты: подтвердили → выплатили часть → остаток уменьшился', async () => {
      const token = await payroll();
      seedMentor([600], 27);
      const typeId = store.seedType({ name: 'Наличные' });
      const row = await sheet(token);
      await send('post', `/api/v1/accounting/salary/${row.id}/confirm`, token).expect(200);

      await send('post', `/api/v1/accounting/salary/${row.id}/pay`, token, {
        amount: 200,
        typeId,
        paidAt: '2026-10-05',
      }).expect(201);

      const after = dataOf<{ paid: number; remaining: number }>(
        await get(`/api/v1/accounting/salary/${row.id}`, token).expect(200),
      );

      expect(after).toMatchObject({ paid: 200, remaining: 70 });
    });

    it('422 на выплату по черновику: его сумма ещё меняется', async () => {
      const token = await payroll();
      seedMentor([600], 27);
      const typeId = store.seedType();
      const row = await sheet(token);

      await send('post', `/api/v1/accounting/salary/${row.id}/pay`, token, {
        amount: 10,
        typeId,
      }).expect(422);
      expect(store.salaryTransactionCount()).toBe(0);
    });

    it('422 на выплату больше остатка — выплата не заведена', async () => {
      const token = await payroll();
      seedMentor([600], 27);
      const typeId = store.seedType();
      const row = await sheet(token);
      await send('post', `/api/v1/accounting/salary/${row.id}/confirm`, token).expect(200);

      await send('post', `/api/v1/accounting/salary/${row.id}/pay`, token, {
        amount: 300,
        typeId,
      }).expect(422);
      expect(store.salaryTransactionCount()).toBe(0);
    });

    it('аванс уменьшает потолок выплаты', async () => {
      const token = await payroll();
      const employeeId = seedMentor([600], 27);
      store.seedApprovedAvans(employeeId, '2026-09', 250);
      const typeId = store.seedType();
      const row = await sheet(token);
      await send('post', `/api/v1/accounting/salary/${row.id}/confirm`, token).expect(200);

      // Total 270, Prepaid 250 → к выплате остаётся 20.
      await send('post', `/api/v1/accounting/salary/${row.id}/pay`, token, {
        amount: 30,
        typeId,
      }).expect(422);
      await send('post', `/api/v1/accounting/salary/${row.id}/pay`, token, {
        amount: 20,
        typeId,
      }).expect(201);
    });

    it('409 на снятие подтверждения при выплатах → отменил выплату → снялось', async () => {
      const token = await payroll();
      seedMentor([600], 27);
      const typeId = store.seedType();
      const row = await sheet(token);
      await send('post', `/api/v1/accounting/salary/${row.id}/confirm`, token).expect(200);

      const payment = dataOf<{ id: string }>(
        await send('post', `/api/v1/accounting/salary/${row.id}/pay`, token, {
          amount: 100,
          typeId,
        }).expect(201),
      );

      await send('delete', `/api/v1/accounting/salary/${row.id}/confirm`, token).expect(409);

      await send('delete', `/api/v1/accounting/salary/transactions/${payment.id}`, token, {
        reason: 'Выплата проведена дважды',
      }).expect(200);
      await send('delete', `/api/v1/accounting/salary/${row.id}/confirm`, token).expect(200);
    });

    it('отмена выплаты требует причины', async () => {
      const token = await payroll();
      seedMentor([600], 27);
      const typeId = store.seedType();
      const row = await sheet(token);
      await send('post', `/api/v1/accounting/salary/${row.id}/confirm`, token).expect(200);
      const payment = dataOf<{ id: string }>(
        await send('post', `/api/v1/accounting/salary/${row.id}/pay`, token, {
          amount: 100,
          typeId,
        }).expect(201),
      );

      await send(
        'delete',
        `/api/v1/accounting/salary/transactions/${payment.id}`,
        token,
        {},
      ).expect(400);
      expect(store.salaryTransactionCount()).toBe(1);
    });

    it('маршрут transactions не путается с карточкой расчёта', async () => {
      const token = await payroll();

      // Ниже `:id` он уехал бы в параметр и вернул 400 от ParseUUIDPipe.
      await send('delete', `/api/v1/accounting/salary/transactions/${randomUUID()}`, token, {
        reason: 'Ошибка',
      }).expect(404);
    });

    it('422 на удаление подтверждённого, 409 на расчёт с выплатами', async () => {
      const token = await payroll();
      seedMentor([600], 27);
      const typeId = store.seedType();
      const row = await sheet(token);

      await send('post', `/api/v1/accounting/salary/${row.id}/confirm`, token).expect(200);
      await send('delete', `/api/v1/accounting/salary/${row.id}`, token).expect(422);

      await send('post', `/api/v1/accounting/salary/${row.id}/pay`, token, {
        amount: 100,
        typeId,
      }).expect(201);
      await send('delete', `/api/v1/accounting/salary/${row.id}/confirm`, token).expect(409);
    });

    it('черновик удаляется', async () => {
      const token = await payroll();
      seedMentor();
      const row = await sheet(token);

      await send('delete', `/api/v1/accounting/salary/${row.id}`, token).expect(200);
      expect(store.salaryCount()).toBe(0);
    });

    it('итоги ведомости считаются по всему набору и уходят в meta', async () => {
      const token = await payroll();
      seedMentor([600], 27);
      seedMentor([300], 27);

      await sheet(token);
      const response = await get('/api/v1/accounting/salary?month=2026-09&limit=1', token).expect(
        200,
      );

      expect(metaOf<{ totals: { count: number; total: number } }>(response).totals).toMatchObject({
        count: 2,
        total: 405,
      });
    });

    it('фильтр по сотруднику и поиск по фамилии сужают ведомость', async () => {
      const token = await payroll();
      const first = seedMentor([600], 27);
      seedMentor([300], 27);
      await sheet(token);

      const byEmployee = await get(
        `/api/v1/accounting/salary?month=2026-09&employeeId=${first}`,
        token,
      ).expect(200);
      expect(dataOf<unknown[]>(byEmployee)).toHaveLength(1);

      const bySearch = await get(
        '/api/v1/accounting/salary?month=2026-09&search=Раҳимов',
        token,
      ).expect(200);
      expect(dataOf<unknown[]>(bySearch)).toHaveLength(2);
    });

    it('выплата зарплаты видна в обзоре отдельным числом и уменьшает Net', async () => {
      const token = await actor([
        'Permission.Accounting.Views',
        'Permission.Accounting.ManageSalary',
      ]);
      seedMentor([600], 27);
      const typeId = store.seedType();
      const row = await sheet(token.token);
      await send('post', `/api/v1/accounting/salary/${row.id}/confirm`, token.token).expect(200);
      await send('post', `/api/v1/accounting/salary/${row.id}/pay`, token.token, {
        amount: 200,
        typeId,
        paidAt: '2026-10-05',
      }).expect(201);

      const overview = dataOf<{ expense: number; salary: number; net: number }>(
        await get('/api/v1/accounting/overview?from=2026-10&to=2026-10', token.token).expect(200),
      );

      // Зарплата не растворяется в `expense`: у неё свой источник (решение 0032).
      expect(overview).toMatchObject({ expense: 0, salary: 200, net: -200 });
    });

    it('право на просмотр не даёт вести ведомость', async () => {
      const token = await viewer();

      await send('post', '/api/v1/accounting/salary', token, { month: '2026-09' }).expect(403);
      await get('/api/v1/accounting/salary?month=2026-09', token).expect(200);
    });

    it('право на оплаты студентов зарплату не открывает', async () => {
      const token = await cashier();

      await send('post', '/api/v1/accounting/salary', token, { month: '2026-09' }).expect(403);
    });

    it('403 студенту и сотруднику без прав', async () => {
      await get('/api/v1/accounting/salary', await studentToken()).expect(403);
      await get('/api/v1/accounting/salary', (await actor([])).token).expect(403);
    });

    it('400 на негодный месяц и негодное тело', async () => {
      const token = await payroll();

      await get('/api/v1/accounting/salary?month=2026-13', token).expect(400);
      await send('post', '/api/v1/accounting/salary', token, { month: '2026-9' }).expect(400);
      await send('post', '/api/v1/accounting/salary', token, {}).expect(400);
      expect(store.salaryCount()).toBe(0);
    });

    it('422 на несуществующего сотрудника в теле формирования', async () => {
      const token = await payroll();

      await send('post', '/api/v1/accounting/salary', token, {
        month: '2026-09',
        employeeId: randomUUID(),
      }).expect(422);
    });
  });

  describe('Бюджет: фонд оплаты труда (ТЗ 5.16)', () => {
    const payroll = async () =>
      (
        await actor([
          'Permission.Accounting.Views',
          'Permission.Accounting.ManageBudget',
          'Permission.Accounting.ManageSalary',
        ])
      ).token;

    it('план фонда считается по выплатам периода и входит в итоги', async () => {
      const token = await payroll();
      const employeeId = store.seedEmployee();
      store.seedTaughtDay(employeeId, '2026-09-01', 600, store.addGroup());
      store.seedMonthLevel(employeeId, '2026-09', 27);
      const typeId = store.seedType();

      const row = (
        await send('post', '/api/v1/accounting/salary', token, { month: '2026-09' }).expect(201)
      ).body as { data: { salaries: { id: string }[] } };
      const salaryId = row.data.salaries[0].id;

      await send('post', `/api/v1/accounting/salary/${salaryId}/confirm`, token).expect(200);
      await send('post', `/api/v1/accounting/salary/${salaryId}/pay`, token, {
        amount: 200,
        typeId,
        paidAt: '2026-09-30',
      }).expect(201);

      const budget = dataOf<{ id: string }>(
        await send('post', '/api/v1/accounting/budget', token, {
          name: 'План на сентябрь',
          periodFrom: '2026-09',
          periodTo: '2026-09',
          salaryAllocated: 500,
        }).expect(201),
      );

      const card = dataOf<{
        salary: { allocated: number; spent: number; remaining: number };
        totals: { allocated: number; spent: number };
      }>(await get(`/api/v1/accounting/budget/${budget.id}`, token).expect(200));

      expect(card.salary).toMatchObject({ allocated: 500, spent: 200, remaining: 300 });
      expect(card.totals).toMatchObject({ allocated: 500, spent: 200 });
    });

    it('незапланированный фонд в итоги не входит, хотя выплаты были', async () => {
      const token = await payroll();
      const budget = dataOf<{ id: string }>(
        await send('post', '/api/v1/accounting/budget', token, {
          name: 'План без зарплаты',
          periodFrom: '2026-09',
          periodTo: '2026-09',
        }).expect(201),
      );

      const card = dataOf<{ salary: unknown; totals: { allocated: number } }>(
        await get(`/api/v1/accounting/budget/${budget.id}`, token).expect(200),
      );

      expect(card.salary).toBeNull();
      expect(card.totals.allocated).toBe(0);
    });

    it('выплата вне периода плана в его освоение не попадает', async () => {
      const token = await payroll();
      const employeeId = store.seedEmployee();
      store.seedTaughtDay(employeeId, '2026-09-01', 600, store.addGroup());
      store.seedMonthLevel(employeeId, '2026-09', 27);
      const typeId = store.seedType();

      const created = (
        await send('post', '/api/v1/accounting/salary', token, { month: '2026-09' }).expect(201)
      ).body as { data: { salaries: { id: string }[] } };
      const salaryId = created.data.salaries[0].id;
      await send('post', `/api/v1/accounting/salary/${salaryId}/confirm`, token).expect(200);
      // Выплата в октябре — план сентября её не видит.
      await send('post', `/api/v1/accounting/salary/${salaryId}/pay`, token, {
        amount: 200,
        typeId,
        paidAt: '2026-10-05',
      }).expect(201);

      const budget = dataOf<{ id: string }>(
        await send('post', '/api/v1/accounting/budget', token, {
          name: 'Только сентябрь',
          periodFrom: '2026-09',
          periodTo: '2026-09',
          salaryAllocated: 500,
        }).expect(201),
      );

      const card = dataOf<{ salary: { spent: number } }>(
        await get(`/api/v1/accounting/budget/${budget.id}`, token).expect(200),
      );

      expect(card.salary.spent).toBe(0);
    });

    it('null снимает план фонда', async () => {
      const token = await payroll();
      const budget = dataOf<{ id: string }>(
        await send('post', '/api/v1/accounting/budget', token, {
          name: 'План с зарплатой',
          periodFrom: '2026-09',
          periodTo: '2026-09',
          salaryAllocated: 500,
        }).expect(201),
      );

      const updated = dataOf<{ salary: unknown }>(
        await send('put', `/api/v1/accounting/budget/${budget.id}`, token, {
          salaryAllocated: null,
        }).expect(200),
      );

      expect(updated.salary).toBeNull();
    });
  });

  // ══════════ Финансовые периоды-отчёты (ТЗ 5.16, сессия 0033) ═══════════════

  describe('Финансовые периоды', () => {
    /** Ведёт отчётность: закрывает периоды, но кассу не трогает. */
    const closer = async () =>
      (await actor(['Permission.Accounting.Views', 'Permission.Accounting.ManagePeriods'])).token;

    /** Полные права: и касса, и расходы, и периоды — им проверяется запрет. */
    const chief = async () =>
      (
        await actor([
          'Permission.Accounting.Views',
          'Permission.Accounting.ManagePayments',
          'Permission.Accounting.ManageExpenses',
          'Permission.Accounting.ManagePeriods',
        ])
      ).token;

    const createPeriod = async (
      token: string,
      body: { name: string; periodFrom: string; periodTo: string },
    ): Promise<{ id: string }> =>
      dataOf<{ id: string }>(
        await send('post', '/api/v1/accounting/periods', token, body).expect(201),
      );

    const q3 = { name: 'III квартал 2026', periodFrom: '2026-07', periodTo: '2026-09' };

    it('заводит период, и числа отчёта считаются на лету', async () => {
      const token = await chief();
      const { groupId } = seedGroup();

      await chargeMonth(token, '2026-08', groupId);
      const { id } = await createPeriod(token, q3);

      const period = dataOf<{
        months: number;
        status: string;
        frozen: boolean;
        report: { charged: number; paid: number; debt: number; net: number };
      }>(await get(`/api/v1/accounting/periods/${id}`, token).expect(200));

      expect(period).toMatchObject({
        months: 3,
        status: 'IN_PROGRESS',
        frozen: false,
        report: { charged: 1200, paid: 0, debt: 1200, net: 0 },
      });
    });

    it('**закрытие замораживает отчёт: правка кассы задним числом его не двигает**', async () => {
      // Главное свойство раздела, проверенное настоящими маршрутами.
      const token = await chief();
      const categoryId = store.seedCategory();

      await send('post', '/api/v1/accounting/expenses', token, {
        categoryId,
        title: 'Аренда за август',
        amount: 300,
        spentAt: '2026-08-05',
      }).expect(201);

      const { id } = await createPeriod(token, q3);
      const closed = dataOf<{ frozen: boolean; report: { expense: number; net: number } }>(
        await send('post', `/api/v1/accounting/periods/${id}/close`, token).expect(200),
      );

      expect(closed).toMatchObject({ frozen: true, report: { expense: 300, net: -300 } });

      // Пока период закрыт, расход внутрь не проходит; снимаем закрытие,
      // проводим второй — и после нового закрытия отчёт пересобран.
      await send('delete', `/api/v1/accounting/periods/${id}/close`, token).expect(200);
      await send('post', '/api/v1/accounting/expenses', token, {
        categoryId,
        title: 'Ещё аренда',
        amount: 500,
        spentAt: '2026-08-06',
      }).expect(201);
      await send('post', `/api/v1/accounting/periods/${id}/close`, token).expect(200);

      const again = dataOf<{ report: { expense: number } }>(
        await get(`/api/v1/accounting/periods/${id}`, token).expect(200),
      );
      expect(again.report.expense).toBe(800);
    });

    it('**архивный период не принимает расход, датированный внутри него**', async () => {
      const token = await chief();
      const categoryId = store.seedCategory();
      const { id } = await createPeriod(token, q3);
      await send('post', `/api/v1/accounting/periods/${id}/close`, token).expect(200);

      const response = await send('post', '/api/v1/accounting/expenses', token, {
        categoryId,
        title: 'Аренда задним числом',
        amount: 300,
        spentAt: '2026-08-15',
      }).expect(422);

      expect((response.body as { error: { message: string } }).error.message).toContain(
        'III квартал 2026',
      );
      expect(store.expenseCount()).toBe(0);
    });

    it('**закрытие снимается — и запись снова проходит**', async () => {
      const token = await chief();
      const categoryId = store.seedCategory();
      const { id } = await createPeriod(token, q3);
      await send('post', `/api/v1/accounting/periods/${id}/close`, token).expect(200);

      const body = { categoryId, title: 'Аренда', amount: 300, spentAt: '2026-08-15' };
      await send('post', '/api/v1/accounting/expenses', token, body).expect(422);

      await send('delete', `/api/v1/accounting/periods/${id}/close`, token).expect(200);
      await send('post', '/api/v1/accounting/expenses', token, body).expect(201);

      expect(store.expenseCount()).toBe(1);
    });

    it('архивный период не принимает начисление своего месяца', async () => {
      const token = await chief();
      const { groupId } = seedGroup();
      const { id } = await createPeriod(token, q3);
      await send('post', `/api/v1/accounting/periods/${id}/close`, token).expect(200);

      await send('post', '/api/v1/accounting/payments/charges', token, {
        month: '2026-08',
        groupId,
      }).expect(422);

      expect(store.chargeCount()).toBe(0);
    });

    it('**платёж открытым днём по месяцу из архива принимается**', async () => {
      // Следствие правила «проверяется дата операции»: долг за закрытый
      // квартал гасится сегодняшним платежом, и открывать период не нужно.
      const token = await chief();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-08', groupId);

      const { id } = await createPeriod(token, q3);
      await send('post', `/api/v1/accounting/periods/${id}/close`, token).expect(200);

      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: 500,
        paidAt: '2026-12-05',
      }).expect(201);

      expect(store.transactionCount()).toBe(1);
    });

    it('а тот же платёж днём внутри архива — 422', async () => {
      const token = await chief();
      const { groupId } = seedGroup();
      const charge = await chargeMonth(token, '2026-08', groupId);

      const { id } = await createPeriod(token, q3);
      await send('post', `/api/v1/accounting/periods/${id}/close`, token).expect(200);

      await send('post', '/api/v1/accounting/payments', token, {
        chargeId: charge.id,
        amount: 500,
        paidAt: '2026-09-05',
      }).expect(422);

      expect(store.transactionCount()).toBe(0);
    });

    it('**периоды не пересекаются — 422 с названием мешающего**', async () => {
      const token = await closer();
      await createPeriod(token, q3);

      const response = await send('post', '/api/v1/accounting/periods', token, {
        name: 'Сентябрь 2026',
        periodFrom: '2026-09',
        periodTo: '2026-09',
      }).expect(422);

      expect((response.body as { error: { message: string } }).error.message).toContain(
        'пересекается с «III квартал 2026»',
      );
      expect(store.periodCount()).toBe(1);
    });

    it('соседние периоды пересечением не считаются', async () => {
      const token = await closer();
      await createPeriod(token, q3);
      await createPeriod(token, {
        name: 'IV квартал 2026',
        periodFrom: '2026-10',
        periodTo: '2026-12',
      });

      expect(store.periodCount()).toBe(2);
    });

    it('пустой период закрывается: «операций не было» — законный отчёт', async () => {
      const token = await closer();
      const { id } = await createPeriod(token, q3);

      const closed = dataOf<{ frozen: boolean; report: { net: number } }>(
        await send('post', `/api/v1/accounting/periods/${id}/close`, token).expect(200),
      );

      expect(closed).toMatchObject({ frozen: true, report: { net: 0 } });
    });

    it('409 на повторное закрытие, 422 на снятие с незакрытого', async () => {
      const token = await closer();
      const { id } = await createPeriod(token, q3);

      await send('delete', `/api/v1/accounting/periods/${id}/close`, token).expect(422);
      await send('post', `/api/v1/accounting/periods/${id}/close`, token).expect(200);
      await send('post', `/api/v1/accounting/periods/${id}/close`, token).expect(409);
    });

    it('закрытый период не правится и не удаляется, но после снятия — оба действия', async () => {
      const token = await closer();
      const { id } = await createPeriod(token, q3);
      await send('post', `/api/v1/accounting/periods/${id}/close`, token).expect(200);

      await send('put', `/api/v1/accounting/periods/${id}`, token, { name: 'Q3 2026' }).expect(422);
      await send('delete', `/api/v1/accounting/periods/${id}`, token).expect(422);

      await send('delete', `/api/v1/accounting/periods/${id}/close`, token).expect(200);
      await send('put', `/api/v1/accounting/periods/${id}`, token, { name: 'Q3 2026' }).expect(200);
      await send('delete', `/api/v1/accounting/periods/${id}`, token).expect(200);

      expect(store.periodCount()).toBe(0);
    });

    it('409 на тёзку без учёта регистра', async () => {
      const token = await closer();
      await createPeriod(token, q3);

      await send('post', '/api/v1/accounting/periods', token, {
        name: 'iii КВАРТАЛ 2026',
        periodFrom: '2027-01',
        periodTo: '2027-03',
      }).expect(409);
    });

    it('400 на перевёрнутый и на слишком длинный период', async () => {
      const token = await closer();

      await send('post', '/api/v1/accounting/periods', token, {
        name: 'Наоборот',
        periodFrom: '2026-09',
        periodTo: '2026-07',
      }).expect(400);

      await send('post', '/api/v1/accounting/periods', token, {
        name: 'Слишком длинный',
        periodFrom: '2020-01',
        periodTo: '2026-01',
      }).expect(400);

      expect(store.periodCount()).toBe(0);
    });

    it('фильтр отбирает периоды по пересечению с отрезком', async () => {
      const token = await closer();
      await createPeriod(token, q3);
      await createPeriod(token, {
        name: 'I квартал 2026',
        periodFrom: '2026-01',
        periodTo: '2026-03',
      });

      const page = dataOf<{ name: string }[]>(
        await get('/api/v1/accounting/periods?from=2026-09&to=2026-12', token).expect(200),
      );

      expect(page.map((row) => row.name)).toEqual(['III квартал 2026']);
    });

    it('закрытый период читается из снимка и виден фильтром по статусу', async () => {
      const token = await closer();
      const { id } = await createPeriod(token, q3);
      await send('post', `/api/v1/accounting/periods/${id}/close`, token).expect(200);

      const page = dataOf<{ frozen: boolean; statusTitle: string }[]>(
        await get('/api/v1/accounting/periods?status=ARCHIVED', token).expect(200),
      );

      expect(page).toHaveLength(1);
      expect(page[0]).toMatchObject({ frozen: true, statusTitle: 'Закрыт' });
    });

    // ─────────────────────────────── Выгрузка ────────────────────────────────

    it('**выгрузка отдаёт CSV с BOM мимо `{ data }`, строкой на месяц и итогом**', async () => {
      const token = await chief();
      const categoryId = store.seedCategory();
      const { groupId } = seedGroup();

      await chargeMonth(token, '2026-08', groupId);
      await send('post', '/api/v1/accounting/expenses', token, {
        categoryId,
        title: 'Аренда',
        amount: 300,
        spentAt: '2026-09-05',
      }).expect(201);

      const { id } = await createPeriod(token, q3);
      const response = await get(`/api/v1/accounting/periods/${id}/export`, token).expect(200);

      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toContain('accounting-period-2026-07');
      expect(response.text.startsWith('﻿')).toBe(true);

      const lines = response.text.replace('﻿', '').trim().split('\r\n');
      expect(lines[0]).toBe('Месяц,Начислено,Оплачено,Долг,Приход,Расход,Зарплата,Итог');
      // Июль без операций остаётся в файле нулями, а не пропадает.
      expect(lines[1]).toBe('2026-07,0.00,0.00,0.00,0.00,0.00,0.00,0.00');
      expect(lines[2]).toBe('2026-08,1200.00,0.00,1200.00,0.00,0.00,0.00,0.00');
      expect(lines[3]).toBe('2026-09,0.00,0.00,0.00,0.00,300.00,0.00,-300.00');
      expect(lines[4]).toBe('Итого,1200.00,0.00,1200.00,0.00,300.00,0.00,-300.00');
    });

    it('итог выгрузки закрытого периода берётся из снимка', async () => {
      const token = await chief();
      const categoryId = store.seedCategory();
      const { id } = await createPeriod(token, q3);

      await send('post', '/api/v1/accounting/expenses', token, {
        categoryId,
        title: 'Аренда',
        amount: 300,
        spentAt: '2026-09-05',
      }).expect(201);
      await send('post', `/api/v1/accounting/periods/${id}/close`, token).expect(200);

      const response = await get(`/api/v1/accounting/periods/${id}/export`, token).expect(200);
      const lines = response.text.replace('﻿', '').trim().split('\r\n');

      expect(lines.at(-1)).toBe('Итого,0.00,0.00,0.00,0.00,300.00,0.00,-300.00');
    });

    // ─────────────────────────────── Доступ ──────────────────────────────────

    it('право на просмотр не даёт заводить и закрывать периоды', async () => {
      const view = await viewer();
      const token = await closer();
      const { id } = await createPeriod(token, q3);

      await get('/api/v1/accounting/periods', view).expect(200);
      await send('post', '/api/v1/accounting/periods', view, {
        name: 'Ещё один',
        periodFrom: '2027-01',
        periodTo: '2027-03',
      }).expect(403);
      await send('post', `/api/v1/accounting/periods/${id}/close`, view).expect(403);
    });

    it('право на оплаты периодами не заведует, а выгрузка открыта `Views`', async () => {
      const token = await closer();
      const { id } = await createPeriod(token, q3);

      await send('post', `/api/v1/accounting/periods/${id}/close`, await cashier()).expect(403);
      // Персональных данных в отчёте нет — только сводные числа с экрана.
      await get(`/api/v1/accounting/periods/${id}/export`, await viewer()).expect(200);
    });

    it('403 студенту и сотруднику без прав', async () => {
      await get('/api/v1/accounting/periods', await studentToken()).expect(403);
      await get('/api/v1/accounting/periods', (await actor([])).token).expect(403);
    });
  });

  describe('OpenAPI', () => {
    it('пути платёжного контура описаны, а у должников только чтение', () => {
      const document = buildOpenApiDocument(app) as unknown as {
        paths: Record<string, Record<string, unknown>>;
      };

      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/accounting/payments',
          '/api/v1/accounting/payments/charges',
          '/api/v1/accounting/payments/prepayment',
          '/api/v1/accounting/payments/transactions',
          '/api/v1/accounting/debtors',
          '/api/v1/accounting/payment-types',
          '/api/v1/accounting/expenses',
          '/api/v1/accounting/expense-categories',
          '/api/v1/accounting/budget',
          '/api/v1/accounting/salary',
          '/api/v1/accounting/periods',
          '/api/v1/accounting/overview',
        ]),
      );

      // У бюджета есть и чтение, и запись: план ведут через тот же раздел.
      expect(Object.keys(document.paths['/api/v1/accounting/budget']).sort()).toEqual([
        'get',
        'post',
      ]);
      expect(Object.keys(document.paths['/api/v1/accounting/budget/{id}']).sort()).toEqual([
        'delete',
        'get',
        'put',
      ]);

      // У обзора своих действий нет — витрина только читает.
      expect(Object.keys(document.paths['/api/v1/accounting/overview'])).toEqual(['get']);

      // Витрина должников ничего не меняет: `POST /accounting/debtors`
      // из перечня ТЗ не заводится (решение сессии 0029).
      expect(Object.keys(document.paths['/api/v1/accounting/debtors'])).toEqual(['get']);

      // Ведомость: чтение и «сформировать месяц».
      expect(Object.keys(document.paths['/api/v1/accounting/salary']).sort()).toEqual([
        'get',
        'post',
      ]);
      // У расчёта нет `post` — подтверждение и выплата стоят своими путями.
      expect(Object.keys(document.paths['/api/v1/accounting/salary/{id}']).sort()).toEqual([
        'delete',
        'get',
        'put',
      ]);
      // Подтверждение снимается тем же путём, что ставится (сверх перечня ТЗ).
      expect(Object.keys(document.paths['/api/v1/accounting/salary/{id}/confirm']).sort()).toEqual([
        'delete',
        'post',
      ]);
      expect(Object.keys(document.paths['/api/v1/accounting/salary/{id}/pay'])).toEqual(['post']);

      // Периоды: чтение и заведение отчёта.
      expect(Object.keys(document.paths['/api/v1/accounting/periods']).sort()).toEqual([
        'get',
        'post',
      ]);
      // У периода нет `post` — закрытие стоит своим путём.
      expect(Object.keys(document.paths['/api/v1/accounting/periods/{id}']).sort()).toEqual([
        'delete',
        'get',
        'put',
      ]);
      // Закрытие снимается тем же путём, что ставится (сверх перечня ТЗ).
      expect(Object.keys(document.paths['/api/v1/accounting/periods/{id}/close']).sort()).toEqual([
        'delete',
        'post',
      ]);
      // Выгрузка только читает.
      expect(Object.keys(document.paths['/api/v1/accounting/periods/{id}/export'])).toEqual([
        'get',
      ]);
    });

    it('заведение периода отвечает 201, закрытие — 200, а выгрузка описана как CSV', () => {
      const document = buildOpenApiDocument(app) as unknown as {
        paths: Record<
          string,
          Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>
        >;
      };

      expect(Object.keys(document.paths['/api/v1/accounting/periods'].post.responses)).toContain(
        '201',
      );

      // Закрытие ничего не создаёт по адресу — 200, а не 201 (правило 0013, 0018).
      const close = Object.keys(
        document.paths['/api/v1/accounting/periods/{id}/close'].post.responses,
      );
      expect(close).toContain('200');
      expect(close).not.toContain('201');

      expect(
        Object.keys(
          document.paths['/api/v1/accounting/periods/{id}/export'].get.responses['200'].content ??
            {},
        ),
      ).toContain('text/csv');
    });

    it('формирование ведомости и выплата отвечают 201, подтверждение — 200', () => {
      const document = buildOpenApiDocument(app) as unknown as {
        paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
      };

      expect(Object.keys(document.paths['/api/v1/accounting/salary'].post.responses)).toContain(
        '201',
      );
      expect(
        Object.keys(document.paths['/api/v1/accounting/salary/{id}/pay'].post.responses),
      ).toContain('201');

      // Подтверждение ничего не создаёт по адресу — 200, а не 201
      // (то же правило, что у финализации недели, 0018, и импорта состава, 0013).
      const confirm = Object.keys(
        document.paths['/api/v1/accounting/salary/{id}/confirm'].post.responses,
      );
      expect(confirm).toContain('200');
      expect(confirm).not.toContain('201');
    });

    it('начисление и предоплата отвечают 201, приём оплаты тоже', () => {
      const document = buildOpenApiDocument(app) as unknown as {
        paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
      };

      expect(
        Object.keys(document.paths['/api/v1/accounting/payments/charges'].post.responses),
      ).toContain('201');
      expect(
        Object.keys(document.paths['/api/v1/accounting/payments/prepayment'].post.responses),
      ).toContain('201');
      expect(Object.keys(document.paths['/api/v1/accounting/payments'].post.responses)).toContain(
        '201',
      );
      // Бюджет создаётся, поэтому 201; правка и удаление — 200.
      expect(Object.keys(document.paths['/api/v1/accounting/budget'].post.responses)).toContain(
        '201',
      );
      expect(Object.keys(document.paths['/api/v1/accounting/budget/{id}'].put.responses)).toContain(
        '200',
      );
    });
  });
});
