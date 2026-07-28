import { Injectable } from '@nestjs/common';

import type { Paginated } from '../common';
import {
  formatIsoMonth,
  nextIsoMonth,
  Paginated as PaginatedResult,
  parseIsoMonth,
} from '../common';
import type { DebtorSummary } from './accounting';
import { fromCents, summarizeDebtors } from './accounting';
import type { ChargeFilter, StudentProfile } from './accounting.repository';
import { AccountingRepository } from './accounting.repository';
import type { DebtorDto, DebtorsQueryDto, DebtorsTotalsDto } from './dto';

/**
 * Должники (ТЗ 5.16: «Debtors: учёт долгов — период, общий долг, выплачено,
 * статус»).
 *
 * Витрина поверх начислений и платежей: `Debtor` из карты сущностей ТЗ 4
 * **не заводится** (решение пользователя, сессия 0029) — долг это разница
 * «начислено − оплачено», и третья таблица стала бы вторым источником истины
 * о том же числе. Пятый раз тот же разбор после `Enrollment` (0012),
 * `Performance` (0019), `LeftCourse` (0025) и `Certificate` (0026).
 *
 * Витрина только читает: долг гасится приёмом оплаты (`POST /accounting/payments`),
 * и второго способа «списать долг» здесь нет — он был бы вторым источником
 * истины о деньгах (то же решение, что у покинувших курсы, где нет отчисления).
 */
@Injectable()
export class DebtorsService {
  constructor(private readonly repository: AccountingRepository) {}

  async findAll(query: DebtorsQueryDto): Promise<Paginated<DebtorDto>> {
    const filter: ChargeFilter = {
      groupId: query.groupId,
      courseId: query.courseId,
      branchId: query.branchId,
      from: query.from === undefined ? undefined : parseIsoMonth(query.from, 'from'),
      to: query.to === undefined ? undefined : nextIsoMonth(parseIsoMonth(query.to, 'to')),
      search: query.search,
    };

    // Долг считается по **всем** должникам, а страница нарезается из готового
    // списка: место в нём зависит от суммы, и усечение выборки дало бы тихо
    // неверный итог (то же решение, что с рейтингом в 0019 и 0024
    // и статистикой оттока в 0025).
    const debts = await this.repository.findDebts(filter);
    const studentIds = debts.map(({ studentId }) => studentId);

    const [totals, prepaid] = await Promise.all([
      this.repository.findChargeTotals(filter, studentIds),
      this.repository.findPrepaid(studentIds),
    ]);

    const rows = summarizeDebtors(
      debts,
      new Map(totals.map((total) => [total.studentId, total])),
      new Map(prepaid.map(({ studentId, cents }) => [studentId, cents])),
    );

    const page = rows.slice(query.skip, query.skip + query.take);
    const students = new Map(
      (await this.repository.findStudentsByIds(page.map(({ studentId }) => studentId))).map(
        (student) => [student.id, student],
      ),
    );

    return PaginatedResult.from(
      page.flatMap((row) => {
        const student = students.get(row.studentId);

        return student === undefined ? [] : [toDto(row, student)];
      }),
      rows.length,
      query,
      { totals: totalsOf(rows) },
    );
  }
}

/**
 * Итоги витрины — одни на все страницы, поэтому уходят в `meta` (0018, 0024).
 * Складываются в тыйинах и переводятся в сомони один раз, в самом конце:
 * сложение округлённых сомони разошлось бы с суммой строк на копейки.
 */
const totalsOf = (rows: DebtorSummary[]): DebtorsTotalsDto => {
  const cents = rows.reduce(
    (totals, row) => ({
      debt: totals.debt + row.debtCents,
      charged: totals.charged + row.chargedCents,
      paid: totals.paid + row.paidCents,
    }),
    { debt: 0, charged: 0, paid: 0 },
  );

  return {
    students: rows.length,
    debt: fromCents(cents.debt),
    charged: fromCents(cents.charged),
    paid: fromCents(cents.paid),
  };
};

const toDto = (row: DebtorSummary, student: StudentProfile): DebtorDto => ({
  student: {
    id: student.id,
    firstName: student.firstName,
    lastName: student.lastName,
    phone: student.phone,
    // Статус профиля стоит рядом с долгом не для красоты: должник, который
    // уже не учится, — другой разговор, чем должник действующей группы.
    status: student.status as DebtorDto['student']['status'],
  },
  branch: student.branch,
  charged: fromCents(row.chargedCents),
  paid: fromCents(row.paidCents),
  debt: fromCents(row.debtCents),
  prepaid: fromCents(row.prepaidCents),
  unpaidMonths: row.unpaidMonths,
  oldestUnpaidMonth: row.oldestUnpaidMonth === null ? null : formatIsoMonth(row.oldestUnpaidMonth),
});
