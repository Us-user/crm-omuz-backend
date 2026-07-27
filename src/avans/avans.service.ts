import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AvansStatus, EmployeeStatus } from '@prisma/client';

import { BusinessRuleException, formatIsoMonth, Paginated, parseIsoMonth } from '../common';
import type {
  AvansQueryDto,
  AvansRequestCancelledDto,
  AvansRequestDto,
  CreateAvansRequestDto,
} from './dto';
import type { AvansEmployee, AvansRequestRow } from './avans.repository';
import { AvansRepository } from './avans.repository';

/**
 * Заявки на аванс (ТЗ 5.14: `GET/POST /employees/{id}/avans`).
 *
 * Здесь только **подача** и просмотр. Рассмотрение — бухгалтерия
 * (`/accounting/avans/{id}/approve|deny`, ТЗ 5.16, Фаза 9): одобрение
 * превращает заявку в `Prepaid` месяца, а это уже расчёт зарплаты.
 *
 * Правила модуля:
 *   - сотрудник из пути должен существовать (404) — он часть адреса, а не тела;
 *   - **одна нерассмотренная заявка на сотрудника** (решение пользователя,
 *     сессия 0022): вторая `PENDING` — 409. Иначе оператор, не увидевший первую,
 *     заводил бы дубль, бухгалтерия одобрила бы обе, и отменить выплату было бы
 *     нечем — как со списанием коинов, которого в проекте нет по устройству;
 *   - выведенный из штата (`INACTIVE`) сотрудник новых заявок не подаёт (422),
 *     но уже поданные остаются: та же асимметрия, что у `INACTIVE` сотрудника
 *     в менторах группы (0010) и выведенной ступени уровня (0021);
 *   - **отзывается только нерассмотренная заявка** — рассмотренная уже вошла
 *     в расчёт месяца, и стирать её значило бы переписывать зарплатную историю.
 *
 * Заявку заводит сотрудник с правом `Permission.Avans.Create` — в том числе
 * от имени ментора (решение пользователя). Подача «о себе» появится вместе
 * с профилем ментора (ТЗ 5.4): своего контура у аккаунта сотрудника пока нет,
 * сессия 0017 отдала ему 403 на `/me`.
 */
@Injectable()
export class AvansService {
  private readonly logger = new Logger(AvansService.name);

  constructor(private readonly repository: AvansRepository) {}

  async findAll(employeeId: string, query: AvansQueryDto): Promise<Paginated<AvansRequestDto>> {
    await this.requireEmployee(employeeId);

    const { rows, total } = await this.repository.findMany({
      employeeId,
      status: query.status,
      from: query.from === undefined ? undefined : parseIsoMonth(query.from, 'from'),
      to: query.to === undefined ? undefined : parseIsoMonth(query.to, 'to'),
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toDto), total, query);
  }

  /**
   * Подача заявки (ТЗ 5.14). Автор берётся из токена — завести заявку от чужого
   * имени нельзя даже по ошибке (то же, что с автором заметки о студенте
   * и ручного начисления коинов); `null` допустим, потому что у аккаунта
   * может не быть профиля сотрудника.
   */
  async create(
    employeeId: string,
    dto: CreateAvansRequestDto,
    accountId: string,
  ): Promise<AvansRequestDto> {
    const employee = await this.requireEmployee(employeeId);

    if (employee.status === EmployeeStatus.INACTIVE) {
      throw new BusinessRuleException(
        `Сотрудник ${employee.lastName} ${employee.firstName} выведен из штата — ` +
          'аванс не начисляется',
        { employeeId },
      );
    }

    const month = parseIsoMonth(dto.month, 'month');

    const pending = await this.repository.findPending(employeeId);
    if (pending) {
      throw new ConflictException(
        `У сотрудника уже есть нерассмотренная заявка на аванс ` +
          `(${String(Number(pending.amount))} сомони за ${formatIsoMonth(pending.month)}). ` +
          'Дождитесь решения по ней или отзовите её',
      );
    }

    const author = await this.repository.findEmployeeByAccount(accountId);

    const created = await this.repository.create({
      employeeId,
      amount: dto.amount,
      reason: dto.reason,
      month,
      createdById: author?.id ?? null,
    });

    this.logger.log(
      `Заявка на аванс ${String(dto.amount)} сомони за ${dto.month} заведена сотруднику ` +
        `${employee.lastName} ${employee.firstName} (${created.id})`,
    );

    return toDto(created);
  }

  /**
   * Отзыв заявки. Маршрута нет в перечне ТЗ 5.14 (там только `GET/POST`),
   * но без него ошибочная заявка осталась бы навсегда — и, из-за правила
   * «одна `PENDING`», закрыла бы сотруднику подачу следующей до самой Фазы 9,
   * где появится рассмотрение. Право то же, что у подачи, — новых возможностей
   * маршрут не даёт. Тот же ход, что с `DELETE …/files/{fileId}` (0009),
   * `PUT` роли ментора (0010), `DELETE` из состава (0012), `DELETE` заметки
   * о студенте (0015) и снятием уровня с месяца (0021).
   */
  async remove(employeeId: string, avansId: string): Promise<AvansRequestCancelledDto> {
    await this.requireEmployee(employeeId);

    const request = await this.repository.findByIdForEmployee(avansId, employeeId);
    if (!request) {
      throw new NotFoundException('Заявка на аванс не найдена у этого сотрудника');
    }

    if (request.status !== AvansStatus.PENDING) {
      throw new BusinessRuleException(
        'Рассмотренная заявка не отзывается: она уже вошла в расчёт зарплаты месяца (ТЗ 5.16)',
        { status: request.status },
      );
    }

    await this.repository.delete(avansId);
    this.logger.log(`Отозвана заявка на аванс ${avansId} сотрудника ${employeeId}`);

    return {
      id: request.id,
      employeeId: request.employeeId,
      amount: Number(request.amount),
      month: formatIsoMonth(request.month),
    };
  }

  /**
   * Сотрудник проверяется отдельным запросом, чтобы отличить «нет такого
   * сотрудника» от «нет такой заявки»: без этого опечатка в идентификаторе
   * выглядела бы как пустой список (то же решение, что для урока внутри курса
   * в сессии 0009 и истории уровней в 0021).
   */
  private async requireEmployee(employeeId: string): Promise<AvansEmployee> {
    const employee = await this.repository.findEmployee(employeeId);
    if (!employee) {
      throw new NotFoundException('Сотрудник не найден');
    }

    return employee;
  }
}

const toDto = (row: AvansRequestRow): AvansRequestDto => ({
  id: row.id,
  employeeId: row.employeeId,
  // `Prisma.Decimal` → число через `Number()`, а не `toNumber()`: так же
  // корректно, но не падает, если в слое данных лежит обычное число (0007).
  amount: Number(row.amount),
  reason: row.reason,
  month: formatIsoMonth(row.month),
  status: row.status,
  createdBy: row.createdBy,
  // Рассмотрение отдаётся объектом, а не тремя полями вперемешку с заявкой:
  // `null` здесь означает «решения ещё нет», и по нему видно состояние сразу.
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
