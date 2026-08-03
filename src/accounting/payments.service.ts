import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import type { Paginated } from '../common';
import {
  BusinessRuleException,
  emptyToNullPatch,
  formatIsoDate,
  formatIsoMonth,
  nextIsoMonth,
  Paginated as PaginatedResult,
  parseIsoDate,
  parseIsoMonth,
} from '../common';
import {
  CHARGE_STATUS_TITLES,
  chargeStatusOf,
  dueCentsOf,
  fromCents,
  toCents,
  totalsOf,
} from './accounting';
import type { ChargeFilter, ChargeInput, ChargeRow, TransactionRow } from './accounting.repository';
import { AccountingRepository } from './accounting.repository';
import type {
  ChargeDeletedDto,
  ChargeMonthDto,
  ChargeRunResultDto,
  ChargesQueryDto,
  CreatePaymentDto,
  CreatePrepaymentDto,
  PaymentDeletedDto,
  PaymentTransactionDto,
  ReasonDto,
  StudentPaymentCardDto,
  StudentPaymentDto,
  TransactionsQueryDto,
  UpdateChargeDto,
  UpdatePaymentDto,
} from './dto';
import { PeriodGuardService } from './period-guard.service';

/**
 * Оплаты студентов (ТЗ 5.16: «Payment's», «Оплаты/долги»).
 *
 * Контур состоит из двух вещей, которые нельзя путать: **начисление** —
 * это месяц обучения со стоимостью курса (`StudentPayment`), **платёж** —
 * полученные деньги (`PaymentTransaction`). Статус месяца («Not paid»)
 * и долг выводятся из их разницы, поэтому ни то, ни другое не хранится
 * отдельным полем-состоянием.
 *
 * Ключевое ограничение, из которого следует всё остальное: **платёж по месяцу
 * не может превышать его остаток**. Переплата — это предоплата, а не «месяц,
 * оплаченный дважды»; благодаря этому долг центра складывается из остатков
 * месяцев без вычитаний в обе стороны, и отчёт по должникам не приходится
 * чинить отрицательными числами.
 */
import { DocxGeneratorService } from '../documents/docx-generator.service';
import { PdfGeneratorService } from '../documents/pdf-generator.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly repository: AccountingRepository,
    private readonly periods: PeriodGuardService,
    private readonly pdfGenerator: PdfGeneratorService,
    private readonly docxGenerator: DocxGeneratorService,
  ) {}

  // ─────────────────────── Начисление месяца (ТЗ 5.16) ──────────────────────

  /**
   * «Начислить месяц» — осознанное действие оператора (решение пользователя,
   * сессия 0029), а не фоновая задача: работающих в проекте нет до Фазы 11,
   * и вешать на очередь начисление денег значило бы обещать то, чего
   * не происходит (то же соображение, что у финализации недели, 0018,
   * закрытия месяца, 0024, и автовыпуска, 0026).
   *
   * Начисляется **действующий состав** каждой группы по стоимости её курса,
   * и сумма кладётся снимком: правка Fee в каталоге не переписывает уже
   * названную студенту цену. Повторный запуск идемпотентен — уже начисленные
   * пары «студент + группа» пропускаются и считаются в `skipped`.
   */
  async chargeMonth(dto: ChargeMonthDto, accountId: string): Promise<ChargeRunResultDto> {
    const month = parseIsoMonth(dto.month, 'month');
    // Месяц обучения и есть дата, по которой начисление попадает в отчёт,
    // поэтому проверка идёт по нему, а не по дню запуска (0033).
    await this.periods.assertMonthOpen(month, 'Начисление месяца');

    if (dto.groupId !== undefined) await this.assertGroupChargeable(dto.groupId);

    const groups = await this.repository.findChargeableGroups(dto.groupId);
    const existing = await this.repository.findExistingChargeKeys(
      month,
      groups.map(({ id }) => id),
    );

    const inputs: ChargeInput[] = [];
    let skipped = 0;

    for (const group of groups) {
      const amountCents = toCents(group.course.fee);

      for (const { studentId } of group.students) {
        if (existing.has(`${group.id}:${studentId}`)) {
          skipped += 1;
          continue;
        }

        inputs.push({ studentId, groupId: group.id, amountCents });
      }
    }

    const charges = await this.repository.createCharges(
      month,
      inputs,
      await this.employeeIdOf(accountId),
    );

    this.logger.log(
      `Начислен месяц ${dto.month}: заведено ${String(charges.length)}, ` +
        `пропущено ${String(skipped)} (уже начислено)` +
        (dto.groupId === undefined ? '' : `, группа ${dto.groupId}`),
    );

    return {
      month: formatIsoMonth(month),
      created: charges.length,
      skipped,
      // Стрелка, а не `map(toChargeDto)`: вторым аргументом `map` передаёт
      // индекс, и он занял бы место необязательной пересчитанной суммы —
      // ошибка, которую поймал юнит-тест на статус месяца.
      charges: charges.map((row) => toChargeDto(row)),
    };
  }

  // ───────────────────────────── Начисления ─────────────────────────────────

  /** Экран «Payment's»: месяцы студентов со статусом и итогами в `meta`. */
  async findAllCharges(query: ChargesQueryDto): Promise<Paginated<StudentPaymentDto>> {
    const filter = chargeFilterOf(query);

    const [{ rows, total }, sums] = await Promise.all([
      this.repository.findManyCharges({
        ...filter,
        sort: query.sort,
        order: query.order,
        skip: query.skip,
        take: query.take,
      }),
      this.repository.aggregateCharges(filter),
    ]);

    return PaginatedResult.from(
      rows.map((row) => toChargeDto(row)),
      total,
      query,
      {
        totals: totalsOf(sums.chargedCents, sums.paidCents),
      },
    );
  }

  /**
   * Карточка месяца вместе с платежами.
   *
   * Принятая сумма здесь считается **по самим платежам**, а не берётся
   * из хранимой колонки: список платежей уже прочитан, проверка ничего
   * не стоит, а расхождение денормализации (которого быть не должно —
   * пересчёт идёт той же транзакцией) обязано быть видно. Тот же приём,
   * что с `WeekResult.sum` в 0018: наружу уходит пересчитанное, а в лог —
   * предупреждение.
   */
  async findCharge(id: string): Promise<StudentPaymentCardDto> {
    const card = await this.repository.findChargeCard(id);
    if (card === null) {
      throw new NotFoundException('Начисление не найдено');
    }

    const paidCents = sumTransactions(card.transactions);
    const storedCents = toCents(card.charge.paidAmount);

    if (paidCents !== storedCents) {
      this.logger.warn(
        `Начисление ${id}: принято по платежам ${String(fromCents(paidCents))}, ` +
          `в колонке ${String(fromCents(storedCents))} — отдаю пересчитанное`,
      );
    }

    return {
      ...toChargeDto(card.charge, paidCents),
      transactions: card.transactions.map(toTransactionDto),
    };
  }

  /** Скидка на месяц с обязательной причиной и примечание (ТЗ 5.16). */
  async updateCharge(id: string, dto: UpdateChargeDto): Promise<StudentPaymentDto> {
    const charge = await this.requireCharge(id);
    // Скидка меняет «начислено» закрытого периода — а это число уже в снимке.
    await this.periods.assertMonthOpen(charge.month, 'Правка начисления');

    const discountCents = dto.discount === undefined ? undefined : toCents(dto.discount);

    if (discountCents !== undefined) {
      this.assertDiscountFits(charge, discountCents, dto.discountReason);
    }

    const updated = await this.repository.updateCharge(id, {
      discountCents,
      discountReason: emptyToNullPatch(dto.discountReason),
      note: emptyToNullPatch(dto.note),
    });

    this.logger.log(
      `Изменено начисление ${chargeTitle(charge)} (${id})` +
        (dto.discount === undefined ? '' : `, скидка: ${String(dto.discount)}`),
    );

    return toChargeDto(updated);
  }

  /**
   * Удаление ошибочного начисления — сверх перечня маршрутов ТЗ 5.16.
   *
   * Месяц начисляется пачкой по всему составу, и ошибка оператора (не тот
   * месяц, не та группа) иначе осталась бы висеть долгом навсегда. Месяц,
   * по которому уже приняты деньги, не удаляется (409): сначала отменяют
   * платежи — иначе деньги повисли бы без месяца. Восьмой раз тот же ход,
   * что с `DELETE …/files/{fileId}` (0009) и снятием сертификата (0026).
   */
  async removeCharge(id: string, dto: ReasonDto): Promise<ChargeDeletedDto> {
    const charge = await this.requireCharge(id);
    await this.periods.assertMonthOpen(charge.month, 'Удаление начисления');

    const transactions = await this.repository.countChargeTransactions(id);

    if (transactions > 0) {
      throw new ConflictException(
        `По месяцу приняты платежи (${String(transactions)}) — отмените их, ` +
          'если начисление ошибочно',
      );
    }

    await this.repository.deleteCharge(id);
    this.logger.log(`Удалено начисление ${chargeTitle(charge)} (${id}): ${dto.reason}`);

    return { id, title: chargeTitle(charge) };
  }

  // ────────────────────────────── Платежи ───────────────────────────────────

  /** Приём оплаты по месяцу (ТЗ 5.16). */
  async pay(dto: CreatePaymentDto, accountId: string): Promise<PaymentTransactionDto> {
    const charge = await this.repository.findChargeById(dto.chargeId);
    if (charge === null) {
      throw new BusinessRuleException('Начисление не найдено', { chargeId: dto.chargeId });
    }

    const paidAt = paidAtOf(dto.paidAt);
    // Проверяется **день платежа**, а не месяц начисления: деньги попадают
    // в кассу тем днём, когда пришли (различие плана и кассы, 0030). Поэтому
    // погасить долг за закрытый квартал платежом сегодняшнего дня можно —
    // отчёт закрытого периода при этом не двигается, он снимок (0033).
    await this.periods.assertDateOpen(paidAt, 'Приём оплаты');

    const amountCents = toCents(dto.amount);
    const remainingCents = remainingCentsOf(charge);

    if (remainingCents === 0) {
      throw new BusinessRuleException(
        `Месяц ${formatIsoMonth(charge.month)} уже закрыт — принятые сверх него деньги ` +
          'оформляются предоплатой',
        { chargeId: dto.chargeId },
      );
    }

    if (amountCents > remainingCents) {
      throw new BusinessRuleException(
        `Сумма больше остатка по месяцу (${String(fromCents(remainingCents))} TJS) — ` +
          'переплата оформляется предоплатой, а не платежом по месяцу',
        { chargeId: dto.chargeId, remaining: fromCents(remainingCents) },
      );
    }

    const transaction = await this.repository.createTransaction({
      studentId: charge.student.id,
      chargeId: charge.id,
      amountCents,
      paidAt,
      typeId: await this.resolveType(dto.typeId),
      comment: dto.comment === undefined ? null : (emptyToNullPatch(dto.comment) ?? null),
      createdById: await this.employeeIdOf(accountId),
    });

    this.logger.log(
      `Принята оплата ${String(dto.amount)} TJS: ${chargeTitle(charge)} (${transaction.id})`,
    );

    return toTransactionDto(transaction);
  }

  /**
   * Предоплата (ТЗ 5.16: «Prepayment для текущего/нового студента»).
   *
   * Это тот же платёж, только без месяца: деньги приняты до того, как месяц
   * начислен. Отдельной модели он не требует — вторая таблица разошлась бы
   * с первой в сумме кассы. Разносится предоплата по месяцу правкой платежа
   * (`PUT …/transactions/{id}` с `chargeId`).
   */
  async prepay(dto: CreatePrepaymentDto, accountId: string): Promise<PaymentTransactionDto> {
    const student = await this.repository.findStudentById(dto.studentId);
    if (student === null) {
      throw new BusinessRuleException('Студент не найден', { studentId: dto.studentId });
    }

    const paidAt = paidAtOf(dto.paidAt);
    await this.periods.assertDateOpen(paidAt, 'Приём предоплаты');

    const transaction = await this.repository.createTransaction({
      studentId: student.id,
      chargeId: null,
      amountCents: toCents(dto.amount),
      paidAt,
      typeId: await this.resolveType(dto.typeId),
      comment: dto.comment === undefined ? null : (emptyToNullPatch(dto.comment) ?? null),
      createdById: await this.employeeIdOf(accountId),
    });

    this.logger.log(
      `Принята предоплата ${String(dto.amount)} TJS: ${student.lastName} ${student.firstName} ` +
        `(${transaction.id})`,
    );

    return toTransactionDto(transaction);
  }

  async findAllTransactions(
    query: TransactionsQueryDto,
  ): Promise<Paginated<PaymentTransactionDto>> {
    const { rows, total, sumCents } = await this.repository.findManyTransactions({
      studentId: query.studentId,
      chargeId: query.chargeId,
      typeId: query.typeId,
      prepayment: query.prepayment,
      from: query.from === undefined ? undefined : parseIsoMonth(query.from, 'from'),
      to: query.to === undefined ? undefined : nextIsoMonth(parseIsoMonth(query.to, 'to')),
      search: query.search,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return PaginatedResult.from(rows.map(toTransactionDto), total, query, {
      totalAmount: fromCents(sumCents),
    });
  }

  /**
   * Правка платежа с причиной (ТЗ 5.16). Ею же предоплата разносится по месяцу
   * и снимается обратно.
   *
   * Правки суммы и привязки проверяются по **итоговому** состоянию: сумма
   * не должна превышать остаток месяца, в котором платёж окажется, — причём
   * из остатка исключается он сам, иначе платёж конфликтовал бы с собственной
   * прежней суммой (тот же приём, что `exceptSlotId` в расписании, 0011).
   */
  async updateTransaction(
    id: string,
    dto: UpdatePaymentDto,
    accountId: string,
  ): Promise<PaymentTransactionDto> {
    const transaction = await this.requireTransaction(id);
    const paidAt = dto.paidAt === undefined ? undefined : parseIsoDate(dto.paidAt, 'paidAt');

    // Обе даты: платёж из закрытого периода не правится, и перенести платёж
    // **в** закрытый период тоже нельзя (0033).
    await this.periods.assertDatesOpen(
      paidAt === undefined ? [transaction.paidAt] : [transaction.paidAt, paidAt],
      'Правка платежа',
    );

    const currentChargeId = transaction.charge?.id ?? null;
    const nextChargeId =
      dto.chargeId === undefined ? currentChargeId : dto.chargeId === '' ? null : dto.chargeId;
    const amountCents =
      dto.amount === undefined ? toCents(transaction.amount) : toCents(dto.amount);

    if (nextChargeId !== null) {
      const charge = await this.repository.findChargeById(nextChargeId);
      if (charge === null) {
        throw new BusinessRuleException('Начисление не найдено', { chargeId: nextChargeId });
      }

      if (charge.student.id !== transaction.student.id) {
        throw new BusinessRuleException(
          'Начисление заведено на другого студента — платёж можно разнести только ' +
            'по месяцам того, от кого приняты деньги',
          { chargeId: nextChargeId },
        );
      }

      // Сам платёж из остатка исключается: он уже учтён в принятой сумме
      // месяца, если был к нему привязан.
      const ownCents = currentChargeId === charge.id ? toCents(transaction.amount) : 0;
      const availableCents = remainingCentsOf(charge) + ownCents;

      if (amountCents > availableCents) {
        throw new BusinessRuleException(
          `Сумма больше остатка по месяцу ${formatIsoMonth(charge.month)} ` +
            `(${String(fromCents(availableCents))} TJS)`,
          { chargeId: nextChargeId, remaining: fromCents(availableCents) },
        );
      }
    }

    const affected = [...new Set([currentChargeId, nextChargeId])].filter(
      (chargeId): chargeId is string => chargeId !== null,
    );

    const updated = await this.repository.updateTransaction(
      id,
      {
        amountCents: dto.amount === undefined ? undefined : amountCents,
        paidAt,
        typeId:
          dto.typeId === undefined
            ? undefined
            : dto.typeId === ''
              ? null
              : await this.resolveType(dto.typeId),
        comment: emptyToNullPatch(dto.comment),
        chargeId: dto.chargeId === undefined ? undefined : nextChargeId,
        editReason: dto.reason,
        editedById: await this.employeeIdOf(accountId),
      },
      affected,
    );

    this.logger.log(`Изменён платёж ${transactionTitle(transaction)} (${id}): ${dto.reason}`);

    return toTransactionDto(updated);
  }

  /**
   * Отмена ошибочного платежа — сверх перечня маршрутов ТЗ 5.16, и по той же
   * причине, что удаление начисления: правка суммы не помогает, если деньги
   * записаны не тому студенту. Причина обязательна и уходит в лог (а с Фазой 13 —
   * в `AuditLog`).
   */
  async removeTransaction(id: string, dto: ReasonDto): Promise<PaymentDeletedDto> {
    const transaction = await this.requireTransaction(id);
    await this.periods.assertDateOpen(transaction.paidAt, 'Отмена платежа');

    await this.repository.deleteTransaction(id, transaction.charge?.id ?? null);
    this.logger.log(`Отменён платёж ${transactionTitle(transaction)} (${id}): ${dto.reason}`);

    return { id, title: transactionTitle(transaction) };
  }

  // ──────────────────────────── Вспомогательное ─────────────────────────────

  private async assertGroupChargeable(groupId: string): Promise<void> {
    const group = await this.repository.findGroupById(groupId);
    if (group === null) {
      throw new BusinessRuleException('Группа не найдена', { groupId });
    }

    if (group.status === 'CANCELLED') {
      throw new BusinessRuleException(`Группа ${group.name} отменена — начислять за неё нечего`, {
        groupId,
      });
    }
  }

  /**
   * Скидка не может быть больше начисленного (400: противоречие внутри самого
   * запроса, как обратный порядок сроков группы в 0008) и не может опустить
   * сумму к оплате ниже уже принятых денег (422: это правило предметной
   * области — иначе месяц оказался бы переплаченным, а вернуть переплату
   * нечем). Ненулевая скидка требует причины — как Reason у смены статуса
   * состава (0012).
   */
  private assertDiscountFits(
    charge: ChargeRow,
    discountCents: number,
    reason: string | undefined,
  ): void {
    const amountCents = toCents(charge.amount);

    if (discountCents > amountCents) {
      throw new BadRequestException(
        `Скидка больше начисленной суммы (${String(fromCents(amountCents))} TJS)`,
      );
    }

    const paidCents = toCents(charge.paidAmount);
    if (amountCents - discountCents < paidCents) {
      throw new BusinessRuleException(
        `По месяцу уже принято ${String(fromCents(paidCents))} TJS — скидка не может ` +
          'опустить сумму к оплате ниже принятого',
        { paid: fromCents(paidCents) },
      );
    }

    const hasReason =
      reason === undefined ? charge.discountReason !== null : reason.trim().length >= 3;

    if (discountCents > 0 && !hasReason) {
      throw new BadRequestException(
        'Скидка без причины не сохраняется: укажите `discountReason` (от 3 символов)',
      );
    }
  }

  /**
   * Способ оплаты из справочника. Выведенный из работы (`INACTIVE`) новым
   * платежам не проставляется — третья по счёту такая асимметрия после
   * `INACTIVE` сотрудника в менторах группы (0010) и выведенной ступени
   * ментора (0021): уже принятые платежи её не теряют.
   */
  private async resolveType(typeId: string | undefined): Promise<string | null> {
    if (typeId === undefined) return null;

    const type = await this.repository.findTypeById(typeId);
    if (type === null) {
      throw new BusinessRuleException('Способ оплаты не найден', { typeId });
    }

    if (type.status === 'INACTIVE') {
      throw new BusinessRuleException(
        `Способ оплаты «${type.name}» выведен из работы — выберите действующий`,
        { typeId },
      );
    }

    return type.id;
  }

  private async requireCharge(id: string): Promise<ChargeRow> {
    const charge = await this.repository.findChargeById(id);
    if (!charge) {
      throw new NotFoundException('Начисление не найдено');
    }

    return charge;
  }

  private async requireTransaction(id: string): Promise<TransactionRow> {
    const transaction = await this.repository.findTransactionById(id);
    if (!transaction) {
      throw new NotFoundException('Платёж не найден');
    }

    return transaction;
  }

  /** Профиль вызывающего: `null` — у аккаунта нет профиля сотрудника. */
  private async employeeIdOf(accountId: string): Promise<string | null> {
    const employee = await this.repository.findEmployeeByAccount(accountId);

    return employee?.id ?? null;
  }

  async exportReceipt(transactionId: string, format: 'pdf' | 'docx' = 'pdf'): Promise<Buffer> {
    const tx = await this.repository.findTransactionById(transactionId);
    if (!tx) {
      throw new NotFoundException(`Транзакция с id "${transactionId}" не найдена`);
    }

    const data = {
      transactionId: tx.id,
      studentName: `${tx.student.firstName} ${tx.student.lastName}`,
      studentPhone: tx.student.phone,
      courseTitle: tx.charge?.group.name,
      month: tx.charge ? formatIsoMonth(tx.charge.month) : undefined,
      amountTjs: Number(tx.amount),
      paymentType: tx.type?.name ?? 'Оплата',
      paidAt: tx.paidAt,
      note: tx.comment ?? undefined,
    };

    if (format === 'docx') {
      return this.docxGenerator.generatePaymentReceiptDocx(data);
    }
    return this.pdfGenerator.generatePaymentReceiptPdf(data);
  }
}

/** Разбор доменных фильтров — общий для списка и для итогов `meta`. */
const chargeFilterOf = (query: ChargesQueryDto): ChargeFilter => ({
  studentId: query.studentId,
  groupId: query.groupId,
  courseId: query.courseId,
  branchId: query.branchId,
  status: query.status,
  from: query.from === undefined ? undefined : parseIsoMonth(query.from, 'from'),
  to: query.to === undefined ? undefined : nextIsoMonth(parseIsoMonth(query.to, 'to')),
  search: query.search,
});

/** Остаток по месяцу в тыйинах — из суммы, скидки и уже принятого. */
const remainingCentsOf = (charge: ChargeRow): number =>
  Math.max(0, dueCentsOf(charge.amount, charge.discount) - toCents(charge.paidAmount));

const sumTransactions = (transactions: TransactionRow[]): number =>
  transactions.reduce((sum, transaction) => sum + toCents(transaction.amount), 0);

/**
 * Полночь сегодняшнего дня по UTC: колонка `paidAt` объявлена `@db.Date`,
 * времени в ней нет. Часовой пояс центра (UTC+5) не учитывается — весь проект
 * работает с календарём в UTC (приём сессий 0021, 0023, 0026).
 */
const today = (): Date => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

const paidAtOf = (value: string | undefined): Date =>
  value === undefined ? today() : parseIsoDate(value, 'paidAt');

const chargeTitle = (charge: ChargeRow): string =>
  `${charge.student.lastName} ${charge.student.firstName}, ${charge.group.name}, ` +
  formatIsoMonth(charge.month);

const transactionTitle = (transaction: TransactionRow): string =>
  `${transaction.student.lastName} ${transaction.student.firstName}, ` +
  `${String(Number(transaction.amount))} TJS от ${formatIsoDate(transaction.paidAt)}`;

/**
 * Начисление наружу. Статус и остаток **выводятся**, а не читаются из колонки:
 * колонки существуют ради отбора и сортировки в БД, а ответ обязан быть
 * пересчитанным (правило `WeekResult.sum`, 0018).
 */
export const toChargeDto = (row: ChargeRow, paidOverrideCents?: number): StudentPaymentDto => {
  const amountCents = toCents(row.amount);
  const discountCents = toCents(row.discount);
  const dueCents = Math.max(0, amountCents - discountCents);
  const paidCents = paidOverrideCents ?? toCents(row.paidAmount);
  const remainingCents = Math.max(0, dueCents - paidCents);
  const status = chargeStatusOf(dueCents, paidCents);

  return {
    id: row.id,
    student: row.student,
    group: { id: row.group.id, name: row.group.name },
    course: { id: row.group.course.id, name: row.group.course.title },
    branch: row.group.branch,
    month: formatIsoMonth(row.month),
    amount: fromCents(amountCents),
    discount: fromCents(discountCents),
    discountReason: row.discountReason,
    due: fromCents(dueCents),
    paid: fromCents(paidCents),
    remaining: fromCents(remainingCents),
    status,
    statusTitle: CHARGE_STATUS_TITLES[status],
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
};

export const toTransactionDto = (row: TransactionRow): PaymentTransactionDto => ({
  id: row.id,
  student: row.student,
  charge:
    row.charge === null
      ? null
      : { id: row.charge.id, month: formatIsoMonth(row.charge.month), group: row.charge.group },
  prepayment: row.charge === null,
  amount: Number(row.amount),
  paidAt: formatIsoDate(row.paidAt),
  type: row.type,
  comment: row.comment,
  edit:
    row.editReason === null || row.editedAt === null
      ? null
      : { reason: row.editReason, at: row.editedAt.toISOString(), by: row.editedBy },
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});
