import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CoinSource } from '@prisma/client';

import { Paginated } from '../common';
import type { AwardCoinsDto, CoinAwardedDto, CoinQueryDto, CoinTransactionDto } from './dto';
import type { CoinTransactionRow } from './student-coins.repository';
import { StudentCoinsRepository } from './student-coins.repository';

/**
 * Коины студента (ТЗ 5.9).
 *
 * Правила модуля:
 *   - студент из пути должен существовать (404) — он часть адреса;
 *   - начисляют сотрудники, причина обязательна;
 *   - **списание запрещено** (ТЗ 5.9): сумма только положительная, а история
 *     не редактируется и не удаляется — отобрать выданное нечем по устройству
 *     модуля, а не по забытой проверке.
 *
 * Автоначисление по итогам недели делает журнал (ТЗ 5.8) — той же транзакцией,
 * что и финализацию, — но по правилу `coinsForWeekSum` из этого модуля.
 */
@Injectable()
export class StudentCoinsService {
  private readonly logger = new Logger(StudentCoinsService.name);

  constructor(private readonly repository: StudentCoinsRepository) {}

  /**
   * Баланс и история (ТЗ 5.9: «Баланс и история у студента»).
   *
   * Баланс уходит в `meta`, а не отдельным запросом: он один на все страницы
   * истории, и ТЗ 3.5 прямо допускает доменные поля в `meta`.
   */
  async findAll(studentId: string, query: CoinQueryDto): Promise<Paginated<CoinTransactionDto>> {
    await this.requireStudent(studentId);

    const [{ rows, total }, balance] = await Promise.all([
      this.repository.findMany({
        studentId,
        source: query.source,
        sort: query.sort,
        order: query.order,
        skip: query.skip,
        take: query.take,
      }),
      this.repository.findBalance(studentId),
    ]);

    return Paginated.from(rows.map(toDto), total, query, { balance });
  }

  /**
   * Ручное начисление (ТЗ 5.9). Автор берётся из токена — начислить от чужого
   * имени нельзя даже по ошибке; `null` допустим, потому что у сотрудника
   * может не быть профиля (аккаунт заведён сид-скриптом на другой профиль).
   */
  async award(studentId: string, dto: AwardCoinsDto, accountId: string): Promise<CoinAwardedDto> {
    const student = await this.requireStudent(studentId);
    const author = await this.repository.findEmployeeByAccount(accountId);

    const { row, balance } = await this.repository.award({
      studentId,
      amount: dto.amount,
      reason: dto.reason,
      source: CoinSource.MANUAL,
      authorId: author?.id ?? null,
    });

    this.logger.log(
      `Студенту ${student.lastName} ${student.firstName} начислено коинов: ` +
        `${String(dto.amount)} (баланс ${String(balance)}, причина: ${dto.reason})`,
    );

    return { transaction: toDto(row), balance };
  }

  private async requireStudent(
    studentId: string,
  ): Promise<{ id: string; firstName: string; lastName: string }> {
    const student = await this.repository.findStudent(studentId);
    if (!student) {
      throw new NotFoundException('Студент не найден');
    }

    return student;
  }
}

const toDto = (row: CoinTransactionRow): CoinTransactionDto => ({
  id: row.id,
  studentId: row.studentId,
  amount: row.amount,
  reason: row.reason,
  source: row.source,
  week: row.week,
  author: row.author,
  createdAt: row.createdAt.toISOString(),
});
