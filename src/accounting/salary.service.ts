import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SalaryStatus } from '@prisma/client';

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
  SortOrder,
} from '../common';
import type { MoneyLike } from './accounting';
import { fromCents, toCents } from './accounting';
import type {
  MonthLevel,
  SalaryFilter,
  SalaryRow,
  SalaryTransactionRow,
} from './accounting.repository';
import { AccountingRepository } from './accounting.repository';
import type {
  CreateSalarySheetDto,
  PaySalaryDto,
  SalaryCardDto,
  SalaryDeletedDto,
  SalaryDto,
  SalaryQueryDto,
  SalaryReasonDto,
  SalarySheetCreatedDto,
  SalaryTransactionDeletedDto,
  SalaryTransactionDto,
  UpdateSalaryDto,
} from './dto';
import { SalarySortField } from './dto';
import { PeriodGuardService } from './period-guard.service';
import type { SalaryComputed } from './salary';
import {
  computeSalary,
  frozenSalary,
  SALARY_STATUS_TITLES,
  salaryTotalsOf,
  summarizeSalaries,
  summarizeSalaryDays,
} from './salary';

/** Живые числа месяца, из которых складывается расчёт черновика. */
interface SalaryContext {
  minutes: Map<string, number>;
  levels: Map<string, MonthLevel>;
  prepaid: Map<string, number>;
  paid: Map<string, number>;
}

/**
 * Зарплата (ТЗ 5.16: «Salary: Total/Prepaid/Remaining/Paid; Daily salaries;
 * часы × часовая ставка уровня месяца + Bonus, подтверждение Done»).
 *
 * Главное здесь то же, что во всей бухгалтерии: **числа выводятся, а не
 * копируются**. Часы приходят из журнала (день знает своего ведущего
 * и длительность — решение пользователя, сессия 0032), ставка — из уровня
 * месяца (0021), `Prepaid` — из одобренных заявок на аванс (0022, 0031),
 * `Paid` — из выплат. Строка расчёта хранит только то, чего вывести неоткуда:
 * премию, примечание, состояние и подпись подтвердившего.
 *
 * Исключение ровно одно и оно осознанное: **при подтверждении Done часы,
 * ставка и итог замораживаются снимком**. После этого правка журнала задним
 * числом или пересмотр ставки в справочнике (а он по решению 0021 действует
 * на все месяцы сразу) не должны двигать сумму, которую человеку уже назвали
 * и, возможно, выплатили. Тот же довод, что у `MonthlyWinner` (0024)
 * и `Graduate.points` (0026).
 */
@Injectable()
export class SalaryService {
  private readonly logger = new Logger(SalaryService.name);

  constructor(
    private readonly repository: AccountingRepository,
    private readonly periods: PeriodGuardService,
  ) {}

  /** Ведомость месяца (ТЗ 5.16: `GET /accounting/salary`). */
  async findAll(query: SalaryQueryDto): Promise<Paginated<SalaryDto>> {
    const filter = this.filterOf(query);

    const [{ rows, total }, setRows] = await Promise.all([
      this.repository.findManySalaries({
        ...filter,
        sort: query.sort,
        order: query.order,
        skip: query.skip,
        take: query.take,
      }),
      this.repository.findSalarySetRows(filter),
    ]);

    // Живые числа читаются один раз на **весь** набор месяца и обслуживают
    // и страницу, и итоги: два экрана про один месяц обязаны показывать одно
    // число по определению (приём 0013, 0029, 0030).
    const context = await this.contextOf(
      filter.month,
      setRows.map((row) => row.employeeId),
      setRows.map((row) => row.id),
    );

    const totals = summarizeSalaries(
      setRows.map((row) => ({
        ...this.resolve(row, context),
        confirmed: row.status === SalaryStatus.DONE,
      })),
    );

    return PaginatedResult.from(
      rows.map((row) => this.toDto(row, context)),
      total,
      query,
      { totals },
    );
  }

  /**
   * Карточка расчёта: строка, дневная раскладка (ТЗ 5.16: «Daily salaries»)
   * и выплаты.
   *
   * Дни читаются из журнала и у подтверждённого расчёта тоже — но суммы в них
   * считаются по **ставке снимка**. Если журнал правили после подтверждения,
   * сумма дней разойдётся с `earned`; это видно, и это правильнее, чем прятать
   * раскладку или подгонять итог под неё.
   */
  async findOne(id: string): Promise<SalaryCardDto> {
    const row = await this.require(id);
    const context = await this.contextOf(row.month, [row.employee.id], [row.id]);
    const computed = this.resolve(rowOf(row), context);

    const [days, transactions] = await Promise.all([
      this.repository.findTaughtDays(row.month, nextIsoMonth(row.month), row.employee.id),
      this.repository.findSalaryTransactions(row.id),
    ]);

    const rateCents = computed.hourlyRate === null ? null : toCents(computed.hourlyRate);

    return {
      ...this.toDto(row, context),
      days: summarizeSalaryDays(days, rateCents).map((day) => ({
        date: formatIsoDate(day.date),
        group: day.group,
        minutes: day.minutes,
        hours: day.hours,
        amount: fromCents(day.amountCents),
      })),
      transactions: transactions.map(toTransactionDto),
    };
  }

  /**
   * «Сформировать ведомость месяца» — осознанное действие, а не фоновая задача:
   * работающих задач в проекте нет до Фазы 11 (тот же ход, что с начислением
   * студентам, 0029, финализацией недели, 0018, и закрытием месяца, 0024).
   *
   * Идемпотентно: уникальный `(employeeId, month)` вместе со `skipDuplicates`
   * не даёт завести вторую строку, поэтому повторный запуск досоздаёт
   * недостающие и ничего не портит.
   */
  async create(dto: CreateSalarySheetDto, accountId: string): Promise<SalarySheetCreatedDto> {
    const month = parseIsoMonth(dto.month, 'month');
    const toExclusive = nextIsoMonth(month);

    if (dto.employeeId !== undefined) await this.requireEmployee(dto.employeeId);

    const candidates = await this.repository.findSalaryCandidates(
      month,
      toExclusive,
      dto.employeeId,
    );

    const created = await this.repository.createSalaries(
      month,
      candidates,
      await this.employeeIdOf(accountId),
    );

    const filter: SalaryFilter = {
      month,
      ...(dto.employeeId === undefined ? {} : { employeeId: dto.employeeId }),
    };
    const setRows = await this.repository.findSalarySetRows(filter);
    const context = await this.contextOf(
      month,
      setRows.map((row) => row.employeeId),
      setRows.map((row) => row.id),
    );

    // Ответ показывает ведомость месяца целиком (как `charges` у начисления
    // студентам, 0029) — окно берётся по размеру уже прочитанного набора,
    // то есть по числу сотрудников центра, а не «сколько угодно».
    const { rows } = await this.repository.findManySalaries({
      ...filter,
      sort: SalarySortField.Employee,
      order: SortOrder.Asc,
      skip: 0,
      take: Math.max(1, setRows.length),
    });

    this.logger.log(
      `Сформирована ведомость за ${formatIsoMonth(month)}: заведено ${String(created)}, ` +
        `пропущено ${String(candidates.length - created)}`,
    );

    return {
      month: formatIsoMonth(month),
      created,
      skipped: candidates.length - created,
      salaries: rows.map((row) => this.toDto(row, context)),
    };
  }

  /**
   * Правка: премия и примечание. Часы и ставку править нельзя — они приходят
   * из журнала и справочника, и ручной ввод завёл бы второй источник истины
   * о том же (разбор 0032).
   */
  async update(id: string, dto: UpdateSalaryDto): Promise<SalaryDto> {
    const row = await this.requireDraft(id, 'правится');

    const updated = await this.repository.updateSalary(id, {
      ...(dto.bonus === undefined ? {} : { bonusCents: toCents(dto.bonus) }),
      note: dto.note === undefined ? undefined : (emptyToNullPatch(dto.note) ?? null),
    });

    this.logger.log(`Изменён расчёт зарплаты ${salaryTitle(row)} (${id})`);

    return this.toDto(updated, await this.contextOf(row.month, [row.employee.id], [row.id]));
  }

  /**
   * Подтверждение Done (ТЗ 5.16): числа замораживаются снимком.
   *
   * Расчёт с часами, но без проставленного уровня месяца, подтвердить нельзя
   * (422): ставки нет, и заморозить пришлось бы ноль — то есть согласиться,
   * что работа стоила нисколько. Пробел чинится простановкой уровня
   * (`PUT /employees/{id}/mentor-levels`), и это ровно тот случай, ради
   * которого решение 0021 сделало отсутствие уровня видимым.
   */
  async confirm(id: string, accountId: string): Promise<SalaryDto> {
    const row = await this.require(id);

    if (row.status === SalaryStatus.DONE) {
      throw new ConflictException(
        `Расчёт ${salaryTitle(row)} уже подтверждён — его числа больше не меняются`,
      );
    }

    const context = await this.contextOf(row.month, [row.employee.id], [row.id]);
    const computed = this.resolve(rowOf(row), context);
    const level = context.levels.get(row.employee.id);

    if (computed.minutes > 0 && level === undefined) {
      throw new BusinessRuleException(
        `На ${formatIsoMonth(row.month)} у сотрудника не проставлен уровень ментора: ` +
          'часовой ставки нет, и подтверждать нечего',
        { month: formatIsoMonth(row.month), hours: computed.hours },
      );
    }

    const confirmed = await this.repository.confirmSalary(id, {
      minutes: computed.minutes,
      hourlyRateCents: level?.hourlyRateCents ?? null,
      totalCents: computed.totalCents,
      confirmedAt: new Date(),
      confirmedById: await this.employeeIdOf(accountId),
    });

    this.logger.log(
      `Подтверждён расчёт зарплаты ${salaryTitle(row)} (${id}): ` +
        `${String(computed.hours)} ч, итог ${String(fromCents(computed.totalCents))} TJS`,
    );

    return this.toDto(confirmed, context);
  }

  /**
   * Снятие подтверждения — сверх перечня маршрутов ТЗ 5.16.
   *
   * Прямое следствие того, что подтверждённый расчёт не правится: ошибочно
   * подтверждённый остался бы таким навсегда. Обратимость в проекте всегда
   * закрывается **явным обратным ходом**, а не отсутствием запрета (0021, 0022,
   * 0024, 0026, 0029, 0031).
   *
   * Расчёт с выплатами не размораживается (409): деньги выданы по
   * согласованной сумме, и вернуть её к «живой» значило бы задним числом
   * изменить то, за что уже заплатили. Сначала отменяют выплаты.
   */
  async unconfirm(id: string): Promise<SalaryDto> {
    const row = await this.require(id);

    if (row.status !== SalaryStatus.DONE) {
      throw new BusinessRuleException(
        `Расчёт ${salaryTitle(row)} не подтверждён — снимать нечего`,
        { status: row.status },
      );
    }

    const payments = await this.repository.countSalaryTransactions(id);
    if (payments > 0) {
      throw new ConflictException(
        `По расчёту ${salaryTitle(row)} уже есть выплаты (${String(payments)}): ` +
          'сначала отмените их, иначе деньги останутся выданными по снятой сумме',
      );
    }

    const updated = await this.repository.unconfirmSalary(id);
    this.logger.log(`Снято подтверждение расчёта зарплаты ${salaryTitle(row)} (${id})`);

    return this.toDto(updated, await this.contextOf(row.month, [row.employee.id], [row.id]));
  }

  /**
   * Выплата (ТЗ 5.16: `POST /accounting/salary/{id}/pay`).
   *
   * Два правила, и оба — про необратимость денег:
   *   - платить можно только по **подтверждённому** расчёту (422): пока он
   *     черновик, его сумма меняется от каждой правки журнала, и выплата
   *     оказалась бы сделанной по числу, которого больше нет;
   *   - выплата не может превышать остаток (422) — то же правило, что
   *     у платежа студента (0029), и следствие у него то же: `Remaining`
   *     складывается без вычитаний в обе стороны.
   */
  async pay(id: string, dto: PaySalaryDto, accountId: string): Promise<SalaryTransactionDto> {
    const row = await this.require(id);

    if (row.status !== SalaryStatus.DONE) {
      throw new BusinessRuleException(
        `Расчёт ${salaryTitle(row)} не подтверждён: выплачивать по черновику нельзя — ` +
          'его сумма ещё меняется от правок журнала',
        { status: row.status },
      );
    }

    const context = await this.contextOf(row.month, [row.employee.id], [row.id]);
    const computed = this.resolve(rowOf(row), context);
    const amountCents = toCents(dto.amount);

    if (amountCents > computed.remainingCents) {
      throw new BusinessRuleException(
        `Выплата больше остатка по расчёту: к выплате ` +
          `${String(fromCents(Math.max(0, computed.remainingCents)))} TJS`,
        {
          amount: dto.amount,
          remaining: fromCents(computed.remainingCents),
          prepaid: fromCents(computed.prepaidCents),
          paid: fromCents(computed.paidCents),
        },
      );
    }

    const paidAt = dto.paidAt === undefined ? today() : parseIsoDate(dto.paidAt, 'paidAt');
    // По дню выплаты, а не по месяцу расчёта: зарплату за сентябрь выдают
    // в октябре, и в отчёт она попадает днём, когда деньги ушли (0030, 0033).
    await this.periods.assertDateOpen(paidAt, 'Выплата зарплаты');

    const transaction = await this.repository.createSalaryTransaction({
      salaryId: id,
      amountCents,
      paidAt,
      typeId: await this.resolveType(dto.typeId),
      comment: dto.comment === undefined ? null : (emptyToNullPatch(dto.comment) ?? null),
      createdById: await this.employeeIdOf(accountId),
    });

    this.logger.log(
      `Выплата ${String(dto.amount)} TJS по расчёту ${salaryTitle(row)} (${transaction.id})`,
    );

    return toTransactionDto(transaction);
  }

  /**
   * Отмена выплаты — сверх перечня ТЗ 5.16, как отмена платежа студента (0029)
   * и удаление расхода (0030). Причина обязательна и уходит в лог: строка
   * о деньгах не должна исчезать бесследно.
   */
  async removeTransaction(id: string, dto: SalaryReasonDto): Promise<SalaryTransactionDeletedDto> {
    const transaction = await this.repository.findSalaryTransactionById(id);
    if (!transaction) {
      throw new NotFoundException('Выплата не найдена');
    }

    await this.periods.assertDateOpen(transaction.paidAt, 'Отмена выплаты');
    await this.repository.deleteSalaryTransaction(id);

    const title = `${String(Number(transaction.amount))} TJS от ${formatIsoDate(transaction.paidAt)}`;
    this.logger.log(`Отменена выплата зарплаты ${title} (${id}): ${dto.reason}`);

    return { id, title };
  }

  /**
   * Удаление расчёта — сверх перечня ТЗ 5.16: ведомость заводится пачкой
   * по всему центру, и попавшая в неё лишняя строка иначе висела бы вечно.
   *
   * Подтверждённый расчёт не удаляется (422): сначала снимают подтверждение —
   * то же двухшаговое правило, что у закрытого бюджета (0031). Расчёт
   * с выплатами не удаляется (409): выплата повисла бы без месяца.
   */
  async remove(id: string): Promise<SalaryDeletedDto> {
    const row = await this.requireDraft(id, 'удаляется');

    const payments = await this.repository.countSalaryTransactions(id);
    if (payments > 0) {
      throw new ConflictException(
        `По расчёту ${salaryTitle(row)} есть выплаты (${String(payments)}): ` +
          'сначала отмените их',
      );
    }

    await this.repository.deleteSalary(id);
    this.logger.log(`Удалён расчёт зарплаты ${salaryTitle(row)} (${id})`);

    return { id, title: salaryTitle(row) };
  }

  // ──────────────────────────────── Правила ─────────────────────────────────

  private filterOf(query: SalaryQueryDto): SalaryFilter {
    return {
      month: query.month === undefined ? currentMonthStart() : parseIsoMonth(query.month, 'month'),
      ...(query.employeeId === undefined ? {} : { employeeId: query.employeeId }),
      ...(query.branchId === undefined ? {} : { branchId: query.branchId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.search === undefined ? {} : { search: query.search }),
    };
  }

  /** Живые числа месяца: часы, ставка, одобренные авансы и выплаты. */
  private async contextOf(
    month: Date,
    employeeIds: string[],
    salaryIds: string[],
  ): Promise<SalaryContext> {
    const ids = [...new Set(employeeIds)];
    const toExclusive = nextIsoMonth(month);

    const [minutes, levels, prepaid, paid] = await Promise.all([
      this.repository.findTaughtMinutes(month, toExclusive, ids),
      this.repository.findMonthLevels(month, ids),
      this.repository.findApprovedAvansTotals(month, ids),
      this.repository.findSalaryPaidTotals(salaryIds),
    ]);

    return { minutes, levels, prepaid, paid };
  }

  /**
   * Числа расчёта: у черновика они выводятся из живых данных, у подтверждённого
   * берутся из снимка. Одно место на список, карточку, выплату и итоги —
   * копия правила разошлась бы с оригиналом на первой же правке.
   */
  private resolve(row: SalaryFactRow, context: SalaryContext): SalaryComputed {
    const bonusCents = toCents(row.bonus);
    const prepaidCents = context.prepaid.get(row.employeeId) ?? 0;
    const paidCents = context.paid.get(row.id) ?? 0;

    if (row.status === SalaryStatus.DONE) {
      return frozenSalary({
        minutes: row.minutes ?? 0,
        hourlyRateCents: row.hourlyRate === null ? null : toCents(row.hourlyRate),
        // `total` у подтверждённого расчёта заполнен всегда: подтверждение
        // пишет три колонки снимка вместе. `null` здесь означал бы порчу
        // данных, и показать премию честнее, чем пересчитать по живым часам.
        totalCents: row.total === null ? bonusCents : toCents(row.total),
        bonusCents,
        prepaidCents,
        paidCents,
      });
    }

    return computeSalary({
      minutes: context.minutes.get(row.employeeId) ?? 0,
      hourlyRateCents: context.levels.get(row.employeeId)?.hourlyRateCents ?? null,
      bonusCents,
      prepaidCents,
      paidCents,
    });
  }

  private toDto(row: SalaryRow, context: SalaryContext): SalaryDto {
    const computed = this.resolve(rowOf(row), context);
    const level = context.levels.get(row.employee.id);
    const totals = salaryTotalsOf(computed);

    return {
      id: row.id,
      employee: {
        id: row.employee.id,
        firstName: row.employee.firstName,
        lastName: row.employee.lastName,
        phone: row.employee.phone,
        branch: row.employee.branch,
      },
      month: formatIsoMonth(row.month),
      status: row.status,
      statusTitle: SALARY_STATUS_TITLES[row.status],
      hours: computed.hours,
      // Ступень показывается по **месяцу**, а ставка — та, по которой считали:
      // у подтверждённого расчёта она из снимка, и если справочник с тех пор
      // пересмотрели, разница видна прямо в карточке.
      level: level === undefined ? null : { id: level.levelId, name: level.levelName },
      hourlyRate: computed.hourlyRate,
      earned: fromCents(computed.earnedCents),
      bonus: fromCents(computed.bonusCents),
      total: totals.total,
      prepaid: totals.prepaid,
      paid: totals.paid,
      remaining: totals.remaining,
      note: row.note,
      confirmedAt: row.confirmedAt === null ? null : row.confirmedAt.toISOString(),
      confirmedBy: row.confirmedBy,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async require(id: string): Promise<SalaryRow> {
    const row = await this.repository.findSalaryById(id);
    if (!row) {
      throw new NotFoundException('Расчёт зарплаты не найден');
    }

    return row;
  }

  private async requireDraft(id: string, action: string): Promise<SalaryRow> {
    const row = await this.require(id);

    if (row.status === SalaryStatus.DONE) {
      throw new BusinessRuleException(
        `Подтверждённый расчёт ${salaryTitle(row)} не ${action}: сначала снимите подтверждение`,
        { status: row.status },
      );
    }

    return row;
  }

  private async requireEmployee(id: string): Promise<void> {
    const employee = await this.repository.findEmployeeById(id);
    if (employee === null) {
      throw new BusinessRuleException('Сотрудник не найден', { employeeId: id });
    }
  }

  /**
   * Способ выплаты из общего справочника (ТЗ 5.16: «Cash/Alif»). Выведенный
   * из работы новым выплатам не проставляется — та же асимметрия, что у платежа
   * студента (0029), ступени ментора (0021) и статьи расхода (0030).
   */
  private async resolveType(typeId: string): Promise<string> {
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

  private async employeeIdOf(accountId: string): Promise<string | null> {
    const employee = await this.repository.findEmployeeByAccount(accountId);

    return employee?.id ?? null;
  }
}

/** Минимум полей расчёта, из которых считаются числа. */
interface SalaryFactRow {
  id: string;
  employeeId: string;
  bonus: MoneyLike;
  status: SalaryStatus;
  minutes: number | null;
  hourlyRate: MoneyLike | null;
  total: MoneyLike | null;
}

const rowOf = (row: SalaryRow): SalaryFactRow => ({
  id: row.id,
  employeeId: row.employee.id,
  bonus: row.bonus,
  status: row.status,
  minutes: row.minutes,
  hourlyRate: row.hourlyRate,
  total: row.total,
});

const salaryTitle = (row: SalaryRow): string =>
  `${row.employee.lastName} ${row.employee.firstName}, ${formatIsoMonth(row.month)}`;

const toTransactionDto = (row: SalaryTransactionRow): SalaryTransactionDto => ({
  id: row.id,
  amount: Number(row.amount),
  paidAt: formatIsoDate(row.paidAt),
  type: row.type,
  comment: row.comment,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});

/** Полночь сегодняшнего дня по UTC: колонка `paidAt` объявлена `@db.Date`. */
const today = (): Date => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

/** Первое число текущего месяца по UTC — как везде в проекте (0021, 0024, 0030). */
const currentMonthStart = (): Date => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
};
