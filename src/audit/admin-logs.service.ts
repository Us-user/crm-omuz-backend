import { BadRequestException, Injectable } from '@nestjs/common';

import { Paginated, parseIsoDate } from '../common';
import { AuditOutcome, outcomeOf } from './audit';
import type { AuditLogRow } from './audit.repository';
import { AuditRepository } from './audit.repository';
import type { AuditLogDto, AuditLogQueryDto } from './dto';

/** Сколько суток укладывается в один запрошенный период — потолок как у отчётов. */
const MAX_PERIOD_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `Administration → Logs` (ТЗ 3.6, 5.15).
 *
 * Витрина поверх журнала: своих правил у неё почти нет, потому что журнал
 * **только читается**. Ни правки, ни удаления строки здесь нет и не будет —
 * запись, которую можно изменить, аудитом не является.
 */
@Injectable()
export class AdminLogsService {
  constructor(private readonly repository: AuditRepository) {}

  async findAll(query: AuditLogQueryDto): Promise<Paginated<AuditLogDto>> {
    const from = query.from === undefined ? undefined : parseIsoDate(query.from, 'from');
    // Правая граница включающая: пользователь пишет «по 31 августа» и ждёт,
    // что действия этого дня попадут в выборку. Наружу уходит начало
    // следующих суток — тот же приём, что с периодами месяцев (0025, 0031).
    const to =
      query.to === undefined
        ? undefined
        : new Date(parseIsoDate(query.to, 'to').getTime() + DAY_MS);

    assertPeriod(from, to);

    const { rows, total } = await this.repository.findMany({
      search: query.search,
      accountId: query.accountId,
      actorType: query.actorType,
      action: query.action,
      entityId: query.entityId,
      succeeded: query.outcome === undefined ? undefined : query.outcome === AuditOutcome.Success,
      from,
      to,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toDto), total, query);
  }
}

/**
 * Период задан наоборот или слишком длинный — 400: это противоречие внутри
 * самого запроса, а не нарушение правила предметной области (0008, 0027).
 * Потолок в год бережёт не столько базу, сколько человека: журнал действий
 * центра за пять лет пролистать нельзя, его фильтруют.
 */
const assertPeriod = (from?: Date, to?: Date): void => {
  if (from === undefined || to === undefined) return;

  if (to.getTime() <= from.getTime()) {
    throw new BadRequestException({
      message: 'Конец периода раньше его начала',
      details: { to: 'Дата окончания не может быть раньше даты начала' },
    });
  }

  if (to.getTime() - from.getTime() > MAX_PERIOD_DAYS * DAY_MS) {
    throw new BadRequestException({
      message: `Период длиннее ${String(MAX_PERIOD_DAYS)} дней`,
      details: { from: 'Сузьте период выборки' },
    });
  }
};

const toDto = (row: AuditLogRow): AuditLogDto => ({
  id: row.id,
  actor: {
    accountId: row.accountId,
    name: row.actorName,
    phone: row.actorPhone,
    type: row.actorType,
  },
  action: row.action,
  method: row.method,
  path: row.path,
  entityId: row.entityId,
  statusCode: row.statusCode,
  outcome: outcomeOf(row.statusCode),
  requestId: row.requestId,
  ip: row.ip,
  userAgent: row.userAgent,
  createdAt: row.createdAt.toISOString(),
});
