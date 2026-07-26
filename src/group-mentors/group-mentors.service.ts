import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EmployeeStatus } from '@prisma/client';

import { BusinessRuleException, Paginated } from '../common';
import type {
  AssignMentorDto,
  GroupMentorDto,
  GroupMentorQueryDto,
  GroupMentorRemovedDto,
  UpdateGroupMentorDto,
} from './dto';
import type { GroupMentorRow, MentorCandidate } from './group-mentors.repository';
import { GroupMentorsRepository } from './group-mentors.repository';

/**
 * Менторы группы (ТЗ 5.5: «менторы (несколько, роли Teaching/Support)»).
 *
 * Правила модуля:
 *   - группа из пути должна существовать (404) — она часть адреса, а не тела;
 *   - сотрудник из тела должен существовать (422, а не 404: ресурс из пути
 *     найден, не найдено то, что пришло в теле, — как при ссылке на филиал
 *     в группе и на группы в «Show to group»);
 *   - выведенного из штата сотрудника ментором не назначают (422), но уже
 *     назначенный остаётся: история группы не переписывается задним числом;
 *   - один сотрудник в группе ровно один раз (409); роль меняется правкой.
 *
 * Позиция «Mentor» не требуется — см. комментарий у модели `GroupMentor`.
 */
@Injectable()
export class GroupMentorsService {
  private readonly logger = new Logger(GroupMentorsService.name);

  constructor(private readonly repository: GroupMentorsRepository) {}

  async findAll(groupId: string, query: GroupMentorQueryDto): Promise<Paginated<GroupMentorDto>> {
    await this.requireGroup(groupId);

    const { rows, total } = await this.repository.findMany({
      groupId,
      search: query.search,
      role: query.role,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toDto), total, query);
  }

  async assign(groupId: string, dto: AssignMentorDto): Promise<GroupMentorDto> {
    const group = await this.requireGroup(groupId);
    const employee = await this.requireEmployee(dto.employeeId);

    if (employee.status === EmployeeStatus.INACTIVE) {
      throw new BusinessRuleException('Сотрудник выведен из штата', {
        employeeId: dto.employeeId,
      });
    }

    const existing = await this.repository.findOne(groupId, dto.employeeId);
    if (existing) {
      throw new ConflictException(
        `${fullName(employee)} уже ментор этой группы (роль ${existing.role})`,
      );
    }

    const mentor = await this.repository.create({
      groupId,
      employeeId: dto.employeeId,
      role: dto.role,
    });

    this.logger.log(
      `Ментор ${fullName(employee)} назначен в группу ${group.name} (роль ${mentor.role})`,
    );

    return toDto(mentor);
  }

  /**
   * Смена роли назначенного ментора. Маршрута `PUT` в перечне ТЗ 5.5 нет
   * (там только `GET/POST/DELETE`), но без него перевод Support → Teaching
   * делался бы снятием и повторным назначением: два запроса и промежуток,
   * в котором у группы нет преподавателя. Право то же — `ManageMentors`.
   */
  async updateRole(
    groupId: string,
    employeeId: string,
    dto: UpdateGroupMentorDto,
  ): Promise<GroupMentorDto> {
    const existing = await this.requireMentor(groupId, employeeId);

    if (existing.role === dto.role) return toDto(existing);

    const mentor = await this.repository.updateRole(groupId, employeeId, dto.role);
    this.logger.log(
      `Ментор ${fullName(mentor.employee)} в группе ${groupId}: роль ${existing.role} → ${mentor.role}`,
    );

    return toDto(mentor);
  }

  async remove(groupId: string, employeeId: string): Promise<GroupMentorRemovedDto> {
    const mentor = await this.requireMentor(groupId, employeeId);

    await this.repository.delete(groupId, employeeId);
    this.logger.log(`Ментор ${fullName(mentor.employee)} снят с группы ${groupId}`);

    return { groupId, employeeId, fullName: fullName(mentor.employee) };
  }

  // ──────────────────────────────── Правила ─────────────────────────────────

  private async requireGroup(groupId: string): Promise<{ id: string; name: string }> {
    const group = await this.repository.findGroup(groupId);
    if (!group) {
      throw new NotFoundException('Группа не найдена');
    }

    return group;
  }

  private async requireEmployee(employeeId: string): Promise<MentorCandidate> {
    const employee = await this.repository.findEmployee(employeeId);
    if (!employee) {
      throw new BusinessRuleException('Сотрудник не найден', { employeeId });
    }

    return employee;
  }

  /**
   * Назначение вместе с группой из пути. Группа проверяется отдельно, чтобы
   * отличить «нет такой группы» от «у группы нет такого ментора»: без этого
   * опечатка в идентификаторе группы выглядела бы как пропавший ментор
   * (то же решение, что для урока внутри курса в сессии 0009).
   */
  private async requireMentor(groupId: string, employeeId: string): Promise<GroupMentorRow> {
    await this.requireGroup(groupId);

    const mentor = await this.repository.findOne(groupId, employeeId);
    if (!mentor) {
      throw new NotFoundException('Ментор не назначен на эту группу');
    }

    return mentor;
  }
}

/** «Фамилия Имя» — тот же порядок, что в `Administration → Users` (сессия 0006). */
const fullName = (employee: { firstName: string; lastName: string }): string =>
  `${employee.lastName} ${employee.firstName}`;

const toDto = (row: GroupMentorRow): GroupMentorDto => ({
  groupId: row.groupId,
  employee: {
    id: row.employee.id,
    firstName: row.employee.firstName,
    lastName: row.employee.lastName,
    middleName: row.employee.middleName,
    phone: row.employee.phone,
    photoUrl: row.employee.photoUrl,
    status: row.employee.status,
  },
  role: row.role,
  assignedAt: row.assignedAt.toISOString(),
});
