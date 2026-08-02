import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AvansStatus, EmployeeStatus } from '@prisma/client';

import { BusinessRuleException, formatIsoMonth, Paginated, parseIsoMonth } from '../common';
import type { AvansReviewRow } from './avans.repository';
import { AvansRepository } from './avans.repository';
import type {
  ApproveAvansDto,
  AvansReviewQueryDto,
  AvansReviewRequestDto,
  DenyAvansDto,
  ReopenAvansDto,
} from './dto';

/**
 * Рассмотрение заявок на аванс (ТЗ 5.16: «Avans: заявка ментора → Approve/Deny
 * (сумма + причина); одобренный = Prepaid», `/accounting/avans`).
 *
 * Вторая половина сценария, начатого в сессии 0022: там заявку **подают**,
 * здесь по ней принимают решение. Колонки рассмотрения (`reviewedBy`,
 * `reviewedAt`, `reviewComment`) заведены сразу тогда же — именно затем,
 * чтобы этой сессии не пришлось второй раз трогать ту же таблицу.
 *
 * Живёт в `src/avans`, а не в `src/accounting`, хотя маршруты вложены
 * в `/accounting/`: рассмотрение — поведение **заявки**, и правило «одна
 * нерассмотренная на сотрудника» обязано жить рядом со своим применением.
 * Второй контроллер на общем репозитории — тот же ход, что у справочника
 * и истории уровней ментора (0021). Заодно `AccountingModule` остаётся
 * без зависимости от соседнего домена (критерий сессии 0006).
 *
 * Право — `Permission.Avans.Approve`, а не `Permission.Accounting.*`: раздел
 * Accounting закрыт на `Director` (0006), а рассматривать авансы вправе
 * и бухгалтер. Код лежит в каталоге с сессии 0005 и до сих пор ничего
 * не открывал.
 */
@Injectable()
export class AvansReviewService {
  private readonly logger = new Logger(AvansReviewService.name);

  constructor(private readonly repository: AvansRepository) {}

  /** Очередь заявок по всему центру (ТЗ 5.16). */
  async findAll(query: AvansReviewQueryDto): Promise<Paginated<AvansReviewRequestDto>> {
    const { rows, total } = await this.repository.findManyForReview({
      employeeId: query.employeeId,
      status: query.status,
      from: query.from === undefined ? undefined : parseIsoMonth(query.from, 'from'),
      to: query.to === undefined ? undefined : parseIsoMonth(query.to, 'to'),
      search: query.search,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toDto), total, query);
  }

  async findOne(id: string): Promise<AvansReviewRequestDto> {
    return toDto(await this.require(id));
  }

  /**
   * Одобрение. Заявка становится `Prepaid` месяца (ТЗ 5.16), поэтому
   * **выведенному из штата аванс не одобряется** (422): выплата тому, кого
   * в штате нет, — ровно то состояние, от которого сессия 0022 закрывала
   * подачу. Четвёртая такая асимметрия после менторства (0010), ступени
   * уровня (0021) и подачи заявки (0022): уже поданная заявка остаётся
   * и отклоняется как обычно, а вот согласиться платить — нет.
   */
  async approve(
    id: string,
    dto: ApproveAvansDto,
    accountId: string,
  ): Promise<AvansReviewRequestDto> {
    const request = await this.requirePending(id);

    if (request.employee.status === EmployeeStatus.INACTIVE) {
      throw new BusinessRuleException(
        `Сотрудник ${request.employee.lastName} ${request.employee.firstName} выведен ` +
          'из штата — аванс не одобряется. Отклоните заявку или верните сотрудника в штат',
        { employeeId: request.employee.id },
      );
    }

    const reviewed = await this.review(id, AvansStatus.APPROVED, dto.comment ?? null, accountId);

    this.logger.log(
      `Одобрена заявка на аванс ${String(Number(request.amount))} сомони за ` +
        `${formatIsoMonth(request.month)} сотруднику ${request.employee.lastName} ` +
        `${request.employee.firstName} (${id})`,
    );

    return reviewed;
  }

  /** Отказ — с обязательной причиной: человек должен узнать, почему отказали. */
  async deny(id: string, dto: DenyAvansDto, accountId: string): Promise<AvansReviewRequestDto> {
    const request = await this.requirePending(id);
    const reviewed = await this.review(id, AvansStatus.DENIED, dto.comment, accountId);

    this.logger.log(
      `Отклонена заявка на аванс ${String(Number(request.amount))} сомони сотрудника ` +
        `${request.employee.lastName} ${request.employee.firstName} (${id}): ${dto.comment}`,
    );

    return reviewed;
  }

  /**
   * Снятие рассмотрения — возврат заявки в `PENDING`.
   *
   * Сверх перечня маршрутов ТЗ 5.16, и по той же причине, что все прежние
   * обратные ходы проекта (0009, 0010, 0012, 0015, 0021, 0022, 0024, 0026,
   * 0029): ошибочно одобренная заявка иначе осталась бы одобренной навсегда,
   * а отозвать её нельзя — рассмотренная не отзывается (0022). Право то же,
   * что у решения, — новых возможностей маршрут не даёт.
   *
   * Возврат проверяет правило «одна нерассмотренная на сотрудника» (409):
   * без этого снятие решения по старой заявке при живой новой оставило бы
   * у человека две `PENDING` — состояние, которое подача не допускает.
   */
  async reopen(id: string, dto: ReopenAvansDto, accountId: string): Promise<AvansReviewRequestDto> {
    const request = await this.require(id);

    if (request.status === AvansStatus.PENDING) {
      throw new BusinessRuleException('Заявка и так не рассмотрена — снимать нечего', {
        status: request.status,
      });
    }

    const pending = await this.repository.findPending(request.employeeId);
    if (pending) {
      throw new ConflictException(
        'У сотрудника уже есть нерассмотренная заявка ' +
          `(${String(Number(pending.amount))} сомони за ${formatIsoMonth(pending.month)}) — ` +
          'вернуть в работу вторую нельзя: рассматривают их по одной',
      );
    }

    const reopened = await this.review(id, AvansStatus.PENDING, null, accountId);

    this.logger.log(
      `Снято рассмотрение заявки на аванс ${id} (было ${request.status}): ${dto.reason}`,
    );

    return reopened;
  }

  private async review(
    id: string,
    status: AvansStatus,
    comment: string | null,
    accountId: string,
  ): Promise<AvansReviewRequestDto> {
    const reviewer = await this.repository.findEmployeeByAccount(accountId);

    return toDto(
      await this.repository.review(id, {
        status,
        // `null` допустим: у аккаунта может не быть профиля сотрудника — то же,
        // что с автором заявки (0022) и подписью заметки о студенте (0015).
        reviewedById: reviewer?.id ?? null,
        comment,
      }),
    );
  }

  /**
   * Заявка, по которой ещё не приняли решение. Повторное рассмотрение — 409,
   * а не 422: это конфликт состояния, как повторная финализация недели (0018)
   * и повторное закрытие месяца (0024). Ошибочное решение снимается
   * `DELETE …/review`, а не переписывается вторым.
   */
  private async requirePending(id: string): Promise<AvansReviewRow> {
    const request = await this.require(id);

    if (request.status !== AvansStatus.PENDING) {
      throw new ConflictException(
        `Заявка уже рассмотрена (${request.status}). Снимите решение, если оно ошибочно`,
      );
    }

    return request;
  }

  private async require(id: string): Promise<AvansReviewRow> {
    const request = await this.repository.findByIdForReview(id);
    if (!request) {
      throw new NotFoundException('Заявка на аванс не найдена');
    }

    return request;
  }
}

const toDto = (row: AvansReviewRow): AvansReviewRequestDto => ({
  id: row.id,
  employeeId: row.employeeId,
  employee: {
    id: row.employee.id,
    firstName: row.employee.firstName,
    lastName: row.employee.lastName,
    status: row.employee.status,
  },
  amount: Number(row.amount),
  reason: row.reason,
  month: formatIsoMonth(row.month),
  status: row.status,
  createdBy: row.createdBy,
  review:
    row.reviewedAt === null
      ? null
      : {
          reviewedBy: row.reviewedBy,
          reviewedAt: row.reviewedAt.toISOString(),
          comment: row.reviewComment,
        },
  createdAt: row.createdAt.toISOString(),
});
