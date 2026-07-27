import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DirectoryStatus } from '@prisma/client';

import { BusinessRuleException, formatIsoMonth, Paginated, parseIsoMonth } from '../common';
import type {
  MentorLevelHistoryDto,
  MentorLevelHistoryQueryDto,
  MentorLevelHistoryRemovedDto,
  SetMentorLevelDto,
} from './dto';
import type { MentorLevelHistoryRow } from './mentor-levels.repository';
import { MentorLevelsRepository } from './mentor-levels.repository';

/**
 * Уровень сотрудника по месяцам (ТЗ 5.14: `GET/PUT /employees/{id}/mentor-levels`).
 *
 * Помесячность — не форма хранения, а требование расчёта: зарплата считается
 * по ставке уровня **того месяца**, за который начисляется (ТЗ 5.16), поэтому
 * повышение в октябре не должно менять сумму за сентябрь.
 *
 * Правила модуля:
 *   - сотрудник из пути должен существовать (404) — он часть адреса, а не тела;
 *   - ступень из тела должна существовать (422, а не 404: ресурс из пути найден,
 *     не найдено то, что пришло в теле, — как филиал в группе и группы
 *     в «Show to group»);
 *   - выведенную из справочника ступень (`INACTIVE`) новым месяцам не проставляют
 *     (422), но уже проставленная остаётся: иначе прошлые месяцы потеряли бы
 *     ставку. Та же асимметрия, что у `INACTIVE` сотрудника в менторах группы
 *     (сессия 0010);
 *   - **одна запись на сотрудника в месяц** (решение пользователя): повторный
 *     `PUT` меняет ступень месяца, а не заводит вторую строку;
 *   - **месяц без записи означает, что уровня не было** (решение пользователя):
 *     ближайший предыдущий сюда не тянется. Пробел виден, а не заполнен
 *     догадкой, и ошибка обнаруживается до выплаты, а не после.
 *
 * Позиция «Mentor» для простановки не требуется — по той же причине, по которой
 * она не требуется для назначения ментором группы (сессия 0010): правило
 * держалось бы на переименуемом названии позиции.
 */
@Injectable()
export class EmployeeMentorLevelsService {
  private readonly logger = new Logger(EmployeeMentorLevelsService.name);

  constructor(private readonly repository: MentorLevelsRepository) {}

  async findAll(
    employeeId: string,
    query: MentorLevelHistoryQueryDto,
  ): Promise<Paginated<MentorLevelHistoryDto>> {
    await this.requireEmployee(employeeId);

    const { rows, total } = await this.repository.findHistory({
      employeeId,
      from: query.from === undefined ? undefined : parseIsoMonth(query.from, 'from'),
      to: query.to === undefined ? undefined : parseIsoMonth(query.to, 'to'),
      levelId: query.levelId,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toDto), total, query);
  }

  /**
   * Простановка уровня на месяц. Идемпотентна: `PUT` задаёт состояние месяца,
   * а не добавляет строку, — поэтому ТЗ 5.14 и называет здесь именно `PUT`.
   */
  async set(employeeId: string, dto: SetMentorLevelDto): Promise<MentorLevelHistoryDto> {
    const employee = await this.requireEmployee(employeeId);
    const month = parseIsoMonth(dto.month, 'month');

    const level = await this.repository.findLevel(dto.levelId);
    if (!level) {
      throw new BusinessRuleException('Уровень ментора не найден', { levelId: dto.levelId });
    }

    // Проставленная ранее ступень остаётся, даже если её вывели из справочника:
    // запрет касается только новых месяцев.
    if (level.status === DirectoryStatus.INACTIVE) {
      throw new BusinessRuleException(
        `Уровень «${level.name}» выведен из справочника и новым месяцам не проставляется`,
        { levelId: dto.levelId },
      );
    }

    const entry = await this.repository.setHistoryEntry(employeeId, month, dto.levelId);

    this.logger.log(
      `Уровень ${level.name} проставлен сотруднику ${employee.lastName} ${employee.firstName} ` +
        `за ${dto.month}`,
    );

    return toDto(entry);
  }

  /**
   * Снятие уровня с месяца. Маршрута нет в перечне ТЗ 5.14 (там только
   * `GET/PUT`), но без него ошибочно проставленный месяц нельзя было бы убрать:
   * «уровня в этом месяце нет» — законное состояние по решению пользователя,
   * и вернуться в него надо чем-то. Право то же, что у простановки, — новых
   * возможностей маршрут не даёт. Тот же ход, что с `DELETE …/files/{fileId}`
   * (0009), `PUT` роли ментора (0010) и `DELETE` заметки о студенте (0015).
   */
  async remove(employeeId: string, monthValue: string): Promise<MentorLevelHistoryRemovedDto> {
    await this.requireEmployee(employeeId);
    const month = parseIsoMonth(monthValue, 'month');

    const entry = await this.repository.findHistoryEntry(employeeId, month);
    if (!entry) {
      throw new NotFoundException('В этом месяце у сотрудника уровень не проставлен');
    }

    await this.repository.deleteHistoryEntry(employeeId, month);
    this.logger.log(`Снят уровень ${entry.level.name} у сотрудника ${employeeId} за ${monthValue}`);

    return {
      employeeId,
      month: formatIsoMonth(entry.month),
      levelName: entry.level.name,
    };
  }

  /**
   * Сотрудник проверяется отдельным запросом, чтобы отличить «нет такого
   * сотрудника» от «в этом месяце уровень не проставлен»: без этого опечатка
   * в идентификаторе выглядела бы как пустая история (то же решение, что
   * для урока внутри курса в сессии 0009).
   */
  private async requireEmployee(
    employeeId: string,
  ): Promise<{ id: string; firstName: string; lastName: string }> {
    const employee = await this.repository.findEmployee(employeeId);
    if (!employee) {
      throw new NotFoundException('Сотрудник не найден');
    }

    return employee;
  }
}

const toDto = (row: MentorLevelHistoryRow): MentorLevelHistoryDto => ({
  id: row.id,
  employeeId: row.employeeId,
  month: formatIsoMonth(row.month),
  level: {
    id: row.level.id,
    name: row.level.name,
    hourlyRate: Number(row.level.hourlyRate),
    status: row.level.status,
  },
  createdAt: row.createdAt.toISOString(),
});
