import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountType, DirectoryStatus, GroupStatus, StudentStatus } from '@prisma/client';
import request from 'supertest';

import { AccountingModule } from 'src/accounting/accounting.module';
import { ChargeStatus } from 'src/accounting/accounting';
import type {
  ChargeFilter,
  ChargeInput,
  ChargeListParams,
  ChargeRow,
  ChargeUpdateInput,
  PaymentTypeListParams,
  PaymentTypeRow,
  PaymentTypeWriteInput,
  StudentProfile,
  TransactionInput,
  TransactionListParams,
  TransactionRow,
  TransactionUpdateInput,
} from 'src/accounting/accounting.repository';
import { AccountingRepository } from 'src/accounting/accounting.repository';
import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, TransformResponseInterceptor } from 'src/common';
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
  private readonly employees = new Map<string, string>();

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

    return id;
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

  chargeCount(): number {
    return this.charges.size;
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
        ]),
      );

      // Витрина должников ничего не меняет: `POST /accounting/debtors`
      // из перечня ТЗ не заводится (решение сессии 0029).
      expect(Object.keys(document.paths['/api/v1/accounting/debtors'])).toEqual(['get']);
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
    });
  });
});
