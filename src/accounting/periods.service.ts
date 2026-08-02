import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AccountingPeriodStatus } from '@prisma/client';

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
import type { AccountingPeriodListParams, AccountingPeriodRow } from './accounting.repository';
import { AccountingRepository } from './accounting.repository';
import type {
  AccountingPeriodDeletedDto,
  AccountingPeriodDto,
  AccountingPeriodsQueryDto,
  CreateAccountingPeriodDto,
  UpdateAccountingPeriodDto,
} from './dto';
import type { PeriodFacts } from './periods';
import {
  ACCOUNTING_PERIOD_STATUS_TITLES,
  formatPeriodCsv,
  frozenFactsOf,
  MAX_PERIOD_MONTHS,
  monthlyPeriodFacts,
  periodReportOf,
} from './periods';

/** Файл выгрузки отчёта — вместе с именами, как у выгрузки лидов (0028). */
export interface PeriodCsvFile {
  content: string;
  fileName: string;
  /** Имя без кириллицы — для заголовка `Content-Disposition` старых клиентов. */
  asciiFileName: string;
  months: number;
}

/**
 * Финансовые периоды-отчёты (ТЗ 5.16: «Accountant: финансовые периоды-отчёты
 * income/expense/paid/notpaid/net, закрытие Inprogress→Archive, выгрузка»).
 *
 * Три решения пользователя (0033) задают здесь всё остальное:
 *
 *   - **период — документ**, а не строка на календарный месяц: ТЗ даёт
 *     `POST /accounting/periods/{id}/close`, то есть у периода свой
 *     идентификатор, а отчётность сдают и месяцем, и кварталом, и годом;
 *   - **закрытие замораживает снимок**: отчёт, который уже сдали, не должен
 *     меняться от правки расхода задним числом (пятый снимок проекта после
 *     0024, 0025, 0026 и 0032);
 *   - **архивный период не принимает операции, датированные внутри него**:
 *     это то самое «задним числом не правится», которое сессии 0029–0032
 *     откладывали четыре раза подряд.
 *
 * Из первого прямо следует, что **периоды не пересекаются** (в отличие
 * от бюджетов, 0031): один платёж, попавший в два отчёта, дал бы два ответа
 * на вопрос «сколько центр заработал».
 *
 * Из третьего — что закрытие обратимо: без `DELETE …/close` ошибочно закрытый
 * период навсегда запер бы кассу за собой. Обратимость в проекте закрывается
 * явным обратным ходом, а не отсутствием запрета (0021, 0022, 0024, 0026, 0031).
 */
@Injectable()
export class PeriodsService {
  private readonly logger = new Logger(PeriodsService.name);

  constructor(private readonly repository: AccountingRepository) {}

  async findAll(query: AccountingPeriodsQueryDto): Promise<Paginated<AccountingPeriodDto>> {
    const params: AccountingPeriodListParams = {
      status: query.status,
      from: query.from === undefined ? undefined : parseIsoMonth(query.from, 'from'),
      to: query.to === undefined ? undefined : parseIsoMonth(query.to, 'to'),
      search: query.search,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    };

    const { rows, total } = await this.repository.findManyPeriods(params);
    const reports = await this.factsOfAll(rows);

    return PaginatedResult.from(
      rows.map((row) => toDto(row, reports.get(row.id) ?? EMPTY_FACTS)),
      total,
      query,
    );
  }

  async findOne(id: string): Promise<AccountingPeriodDto> {
    const period = await this.require(id);
    const reports = await this.factsOfAll([period]);

    return toDto(period, reports.get(id) ?? EMPTY_FACTS);
  }

  async create(dto: CreateAccountingPeriodDto, accountId: string): Promise<AccountingPeriodDto> {
    await this.assertNameFree(dto.name);

    const periodFrom = parseIsoMonth(dto.periodFrom, 'periodFrom');
    const periodTo = parseIsoMonth(dto.periodTo, 'periodTo');
    assertPeriod(periodFrom, periodTo);
    await this.assertNoOverlap(periodFrom, periodTo);

    const period = await this.repository.createPeriod({
      name: dto.name,
      description:
        dto.description === undefined ? null : (emptyToNullPatch(dto.description) ?? null),
      periodFrom,
      periodTo,
      createdById: await this.employeeIdOf(accountId),
    });

    this.logger.log(
      `Заведён финансовый период «${period.name}» на ${formatIsoMonth(periodFrom)}…` +
        `${formatIsoMonth(periodTo)} (${period.id})`,
    );

    return this.findOne(period.id);
  }

  async update(id: string, dto: UpdateAccountingPeriodDto): Promise<AccountingPeriodDto> {
    const existing = await this.require(id);
    this.assertOpen(
      existing,
      'Закрытый период не правится: это снимок сданного отчёта. ' +
        'Верните его в работу (`DELETE /accounting/periods/{id}/close`), если он нужен другим',
    );

    if (dto.name !== undefined && dto.name.toLowerCase() !== existing.name.toLowerCase()) {
      await this.assertNameFree(dto.name);
    }

    // Период сверяется по **итоговому** состоянию: передать можно один конец,
    // и сравнивать его с пустотой значило бы пропускать «поставили конец раньше
    // существующего начала» (приём сессий 0008, 0011, 0018, 0031).
    const periodFrom =
      dto.periodFrom === undefined
        ? existing.periodFrom
        : parseIsoMonth(dto.periodFrom, 'periodFrom');
    const periodTo =
      dto.periodTo === undefined ? existing.periodTo : parseIsoMonth(dto.periodTo, 'periodTo');
    assertPeriod(periodFrom, periodTo);

    if (dto.periodFrom !== undefined || dto.periodTo !== undefined) {
      await this.assertNoOverlap(periodFrom, periodTo, id);
    }

    const period = await this.repository.updatePeriod(id, {
      name: dto.name,
      description: emptyToNullPatch(dto.description),
      periodFrom: dto.periodFrom === undefined ? undefined : periodFrom,
      periodTo: dto.periodTo === undefined ? undefined : periodTo,
    });

    this.logger.log(`Изменён финансовый период «${period.name}» (${id})`);

    return this.findOne(period.id);
  }

  /**
   * Закрытие периода (ТЗ 5.16: `POST /accounting/periods/{id}/close`,
   * «Inprogress→Archive»).
   *
   * Числа снимаются **в момент закрытия** и записываются пятью колонками.
   * Отсюда два следствия, которых не было бы у расчёта на лету: сданный отчёт
   * переживает любую последующую правку кассы, а сам период с этого момента
   * операций внутри себя не принимает.
   *
   * Пустой период закрывается: «за квартал не было ни одной операции» —
   * законный отчёт, и отказывать в нём значило бы требовать выручку ради
   * возможности закрыть месяц.
   */
  async close(id: string, accountId: string): Promise<AccountingPeriodDto> {
    const period = await this.require(id);

    if (period.status === AccountingPeriodStatus.ARCHIVED) {
      throw new ConflictException(
        `Период «${period.name}» уже закрыт. Снимите закрытие, если отчёт нужно пересобрать`,
      );
    }

    const facts = await this.liveFacts(period);

    const closed = await this.repository.closePeriod(id, {
      facts,
      closedAt: new Date(),
      closedById: await this.employeeIdOf(accountId),
    });

    const report = periodReportOf(facts);
    this.logger.log(
      `Закрыт финансовый период «${closed.name}» (${id}): приход ${String(report.income)}, ` +
        `расход ${String(report.expense)}, зарплата ${String(report.salary)}, ` +
        `итог ${String(report.net)}`,
    );

    return toDto(closed, facts);
  }

  /**
   * Снятие закрытия — сверх перечня маршрутов ТЗ 5.16 и прямое следствие того,
   * что архивный период запирает кассу: без обратного хода ошибочно закрытый
   * квартал навсегда запретил бы правки внутри себя, а исправить это было бы
   * нечем. Одиннадцатый раз тот же ход (0009, 0010, 0012, 0015, 0021, 0022,
   * 0024, 0026, 0029, 0031, 0032).
   *
   * Снимок гасится целиком: числа снова считаются на лету, и период честно
   * показывает то, что в кассе есть сейчас.
   */
  async reopen(id: string): Promise<AccountingPeriodDto> {
    const period = await this.require(id);

    if (period.status !== AccountingPeriodStatus.ARCHIVED) {
      throw new BusinessRuleException(`Период «${period.name}» не закрыт — снимать нечего`, {
        status: period.status,
      });
    }

    const reopened = await this.repository.reopenPeriod(id);
    this.logger.log(`Снято закрытие периода «${reopened.name}» (${id}): снимок отчёта погашен`);

    // Числа считаются по уже возвращённой строке, а не вторым чтением: снимок
    // погашен этим же запросом, и повторный `findOne` спросил бы БД о том,
    // что мы только что записали.
    return toDto(reopened, await this.liveFacts(reopened));
  }

  /**
   * Удаление периода — сверх перечня маршрутов ТЗ 5.16, как у бюджета (0031),
   * и причина не требуется по тому же доводу: исчезает рамка отчёта, а не
   * запись о деньгах — сами платежи и расходы остаются на месте.
   *
   * Закрытый период не удаляется: сначала снимите закрытие. Иначе сданный
   * отчёт можно было бы стереть одним запросом, минуя явный обратный ход.
   */
  async remove(id: string): Promise<AccountingPeriodDeletedDto> {
    const period = await this.require(id);
    this.assertOpen(
      period,
      'Закрытый период не удаляется: это снимок сданного отчёта. ' +
        'Снимите закрытие, если удаление действительно нужно',
    );

    await this.repository.deletePeriod(id);
    this.logger.log(`Удалён финансовый период «${period.name}» (${id})`);

    return { id, name: period.name };
  }

  /**
   * Выгрузка отчёта (ТЗ 5.16: «выгрузка») — помесячная раскладка плюс итог.
   *
   * Итоговая строка берётся из того же источника, что и карточка: у закрытого
   * периода — из снимка. Месячные строки при этом считаются по живым данным,
   * поэтому у архивного периода их сумма может разойтись с итогом — осознанно
   * и ровно так же, как дневная раскладка подтверждённой зарплаты (0032).
   * Расхождение означает, что кассу правили после закрытия, и его лучше видеть,
   * чем прятать подгонкой последней строки.
   */
  async exportCsv(id: string): Promise<PeriodCsvFile> {
    const period = await this.require(id);
    const months = monthSequence(period.periodFrom, period.periodTo);
    const toExclusive = nextIsoMonth(period.periodTo);

    const [charges, income, expenses, salaries] = await Promise.all([
      this.repository.findMonthlyChargeTotals(period.periodFrom, toExclusive),
      this.repository.findIncomeFacts(period.periodFrom, toExclusive),
      this.repository.findExpenseFacts(period.periodFrom, toExclusive),
      this.repository.findSalaryFacts(period.periodFrom, toExclusive),
    ]);

    const facts = frozenFactsOf(snapshotOf(period)) ?? (await this.liveFacts(period));

    const content = formatPeriodCsv(
      months,
      monthlyPeriodFacts(months, charges, income, expenses, salaries),
      periodReportOf(facts),
    );

    this.logger.log(
      `Выгружен отчёт периода «${period.name}» (${id}): месяцев ${String(months.length)}`,
    );

    return {
      content,
      fileName: `Отчёт ${period.name}.csv`,
      asciiFileName: `accounting-period-${formatIsoMonth(period.periodFrom)}-${formatIsoMonth(
        period.periodTo,
      )}.csv`,
      months: months.length,
    };
  }

  /**
   * Живые числа периода — четыре агрегата БД.
   *
   * `charged`/`paid` берутся **тем же** `aggregateCharges`, что и `meta.totals`
   * списка оплат и `charges` обзора: три экрана обязаны показывать одно число
   * по определению, а не по совпадению (приём 0013, 0025, 0026, 0029, 0030).
   */
  private async liveFacts(period: { periodFrom: Date; periodTo: Date }): Promise<PeriodFacts> {
    const from = period.periodFrom;
    const to = nextIsoMonth(period.periodTo);

    const [charges, incomeCents, expenseCents, salaryCents] = await Promise.all([
      this.repository.aggregateCharges({ from, to }),
      this.repository.sumIncome(from, to),
      this.repository.sumExpenses(from, to),
      this.repository.sumSalaryPaid(from, to),
    ]);

    return {
      chargedCents: charges.chargedCents,
      paidCents: charges.paidCents,
      incomeCents,
      expenseCents,
      salaryCents,
    };
  }

  /**
   * Числа для страницы списка.
   *
   * У закрытых периодов запросов нет вовсе — их числа лежат в снимке. Живые
   * считаются по четыре агрегата на период: сгруппировать их, как бюджеты
   * по одинаковым окнам (0031), здесь нельзя — периоды не пересекаются,
   * то есть каждое окно своё по определению. На практике незакрытым остаётся
   * один-два последних периода, а худший случай (страница из двадцати
   * незакрытых — восемьдесят агрегатов) назван честно в логе сессии.
   */
  private async factsOfAll(rows: AccountingPeriodRow[]): Promise<Map<string, PeriodFacts>> {
    const facts = new Map<string, PeriodFacts>();

    const live: AccountingPeriodRow[] = [];
    for (const row of rows) {
      const frozen = frozenFactsOf(snapshotOf(row));
      if (frozen === null) live.push(row);
      else facts.set(row.id, frozen);
    }

    const computed = await Promise.all(live.map((row) => this.liveFacts(row)));
    live.forEach((row, index) => {
      facts.set(row.id, computed[index] ?? EMPTY_FACTS);
    });

    return facts;
  }

  private async require(id: string): Promise<AccountingPeriodRow> {
    const period = await this.repository.findPeriodById(id);
    if (!period) {
      throw new NotFoundException('Финансовый период не найден');
    }

    return period;
  }

  private assertOpen(period: AccountingPeriodRow, message: string): void {
    if (period.status === AccountingPeriodStatus.ARCHIVED) {
      throw new BusinessRuleException(message, { status: period.status });
    }
  }

  private async assertNameFree(name: string): Promise<void> {
    const twin = await this.repository.findPeriodByName(name);
    if (twin) {
      throw new ConflictException(`Период «${twin.name}» уже заведён`);
    }
  }

  /**
   * Периоды отчётности не пересекаются — 422 с названием мешающего периода.
   *
   * Обезличенная ошибка здесь была бы особенно бесполезной: оператор видит
   * список отчётов и не может понять, какой именно из них мешает.
   */
  private async assertNoOverlap(from: Date, to: Date, exceptId?: string): Promise<void> {
    const clash = await this.repository.findOverlappingPeriod(from, to, exceptId);
    if (clash) {
      throw new BusinessRuleException(
        `Период пересекается с «${clash.name}» ` +
          `(${formatIsoMonth(clash.periodFrom)}…${formatIsoMonth(clash.periodTo)}): ` +
          'один платёж не может попасть в два отчёта',
        {
          periodId: clash.id,
          periodFrom: formatIsoMonth(clash.periodFrom),
          periodTo: formatIsoMonth(clash.periodTo),
        },
      );
    }
  }

  private async employeeIdOf(accountId: string): Promise<string | null> {
    const employee = await this.repository.findEmployeeByAccount(accountId);

    return employee?.id ?? null;
  }
}

/** Пустой отчёт — им отвечает период, у которого не нашлось ни одной операции. */
const EMPTY_FACTS: PeriodFacts = {
  chargedCents: 0,
  paidCents: 0,
  incomeCents: 0,
  expenseCents: 0,
  salaryCents: 0,
};

/**
 * Период не может кончаться раньше, чем начинается, и не бывает длиннее
 * потолка. Оба — 400: это противоречие внутри самого запроса, а не нарушение
 * правила предметной области (приём сессий 0008, 0031).
 */
const assertPeriod = (from: Date, to: Date): void => {
  if (to.getTime() < from.getTime()) {
    throw new BadRequestException({
      message: 'Период отчёта задан наоборот',
      details: { periodTo: 'Конец периода не может быть раньше начала' },
    });
  }

  const months = monthSequence(from, to).length;
  if (months > MAX_PERIOD_MONTHS) {
    throw new BadRequestException({
      message: 'Период отчёта слишком длинный',
      details: {
        periodTo: `Максимум ${String(MAX_PERIOD_MONTHS)} месяцев, запрошено ${String(months)}`,
      },
    });
  }
};

/** Снимок строки в тыйинах — в таком виде его читают чистые функции. */
const snapshotOf = (row: AccountingPeriodRow) => ({
  status: row.status,
  chargedCents: row.charged === null ? null : toCents(row.charged),
  paidCents: row.paid === null ? null : toCents(row.paid),
  incomeCents: row.income === null ? null : toCents(row.income),
  expenseCents: row.expense === null ? null : toCents(row.expense),
  salaryCents: row.salary === null ? null : toCents(row.salary),
});

const toDto = (row: AccountingPeriodRow, facts: PeriodFacts): AccountingPeriodDto => ({
  id: row.id,
  name: row.name,
  description: row.description,
  periodFrom: formatIsoMonth(row.periodFrom),
  periodTo: formatIsoMonth(row.periodTo),
  months: monthSequence(row.periodFrom, row.periodTo).length,
  status: row.status,
  statusTitle: ACCOUNTING_PERIOD_STATUS_TITLES[row.status],
  report: periodReportOf(facts),
  frozen: frozenFactsOf(snapshotOf(row)) !== null,
  closedAt: row.closedAt === null ? null : row.closedAt.toISOString(),
  closedBy: row.closedBy,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});
