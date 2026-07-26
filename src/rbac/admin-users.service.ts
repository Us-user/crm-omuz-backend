import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AccountType } from '@prisma/client';

import { BusinessRuleException, Paginated } from '../common';
import type {
  AdminUserDto,
  AdminUserQueryDto,
  AssignRolesDto,
  UserRoleDto,
  UserRolesDto,
} from './dto';
import type { AccountForRoles, AdminUserRow, RoleRow } from './admin-users.repository';
import { AdminUsersRepository } from './admin-users.repository';
import { DIRECTOR_POSITION_NAME } from './rbac.constants';

/**
 * `Administration → Users` (ТЗ 5.15): все аккаунты и назначение им ролей.
 *
 * «Роль» на этом экране — позиция сотрудника: права выдаются только позициями
 * (ТЗ 3.2, решение Фазы 2). Отсюда два следствия, которые видит пользователь API:
 *   - студенту роль назначить нельзя — ему по ТЗ доступен только просмотр своих данных;
 *   - последнего `Director` разжаловать нельзя, иначе администрировать систему
 *     станет некому: назначение ролей само требует права.
 */
@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(private readonly repository: AdminUsersRepository) {}

  async findAll(query: AdminUserQueryDto): Promise<Paginated<AdminUserDto>> {
    const { rows, total } = await this.repository.findMany({
      search: query.search,
      type: query.type,
      status: query.status,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toAdminUser), total, query);
  }

  async assignRoles(accountId: string, dto: AssignRolesDto): Promise<UserRolesDto> {
    const { employee } = await this.requireEmployeeAccount(accountId);
    await this.requirePositions(dto.positionIds);

    const changed = await this.repository.assignPositions(employee.id, dto.positionIds);

    this.logger.log(
      `Аккаунту ${accountId} назначено ролей: ${String(changed)} ` +
        `из ${String(dto.positionIds.length)} запрошенных`,
    );

    return this.rolesResponse(accountId, employee.id, changed);
  }

  async removeRoles(accountId: string, dto: AssignRolesDto): Promise<UserRolesDto> {
    const { employee } = await this.requireEmployeeAccount(accountId);
    const positions = await this.requirePositions(dto.positionIds);

    await this.assertDirectorSurvives(positions, employee);

    const changed = await this.repository.removePositions(employee.id, dto.positionIds);

    this.logger.log(`У аккаунта ${accountId} снято ролей: ${String(changed)}`);

    return this.rolesResponse(accountId, employee.id, changed);
  }

  /** Роли живут у профиля сотрудника, поэтому аккаунт обязан им обладать. */
  private async requireEmployeeAccount(
    accountId: string,
  ): Promise<AccountForRoles & { employee: NonNullable<AccountForRoles['employee']> }> {
    const account = await this.repository.findAccountForRoles(accountId);
    if (!account) {
      throw new NotFoundException('Аккаунт не найден');
    }

    if (account.type !== AccountType.EMPLOYEE || !account.employee) {
      throw new BusinessRuleException(
        'Роли назначаются только аккаунтам сотрудников: права выдаются позициями сотрудника (ТЗ 3.2)',
      );
    }

    return { ...account, employee: account.employee };
  }

  /**
   * Ссылка на несуществующую позицию — 422, а не 404: сам аккаунт из пути найден,
   * не найдено то, что пришло в теле. Молча пропустить неизвестный идентификатор
   * нельзя: администратор решил бы, что роль назначена.
   */
  private async requirePositions(positionIds: readonly string[]): Promise<RoleRow[]> {
    const positions = await this.repository.findPositionsByIds(positionIds);

    if (positions.length !== positionIds.length) {
      const found = new Set(positions.map(({ id }) => id));
      throw new BusinessRuleException(
        'Часть позиций не найдена',
        positionIds.filter((id) => !found.has(id)),
      );
    }

    return positions;
  }

  /**
   * Снятие `Director` с последнего руководителя запрещено (ТЗ 3.2, 5.16):
   * бухгалтерия доступна только этой позиции, а выдать её обратно мог бы лишь
   * тот, у кого есть право назначать роли, — восстанавливать пришлось бы через БД.
   */
  private async assertDirectorSurvives(
    positions: readonly RoleRow[],
    employee: { positionIds: string[] },
  ): Promise<void> {
    const director = positions.find(
      (position) => position.isSystem && position.name === DIRECTOR_POSITION_NAME,
    );

    if (!director || !employee.positionIds.includes(director.id)) return;

    const holders = await this.repository.countPositionAssignments(director.id);
    if (holders <= 1) {
      throw new BusinessRuleException(
        `Нельзя снять позицию ${DIRECTOR_POSITION_NAME} с последнего руководителя: ` +
          'администрировать систему станет некому',
      );
    }
  }

  private async rolesResponse(
    accountId: string,
    employeeId: string,
    changed: number,
  ): Promise<UserRolesDto> {
    const roles = await this.repository.findEmployeeRoles(employeeId);

    return { accountId, employeeId, roles: roles.map(toRole).sort(byName), changed };
  }
}

const toRole = (row: RoleRow): UserRoleDto => ({
  id: row.id,
  name: row.name,
  isSystem: row.isSystem,
});

const byName = (a: UserRoleDto, b: UserRoleDto): number => a.name.localeCompare(b.name);

const toAdminUser = (row: AdminUserRow): AdminUserDto => {
  const profile = row.employee ?? row.student;

  return {
    id: row.id,
    phone: row.phone,
    email: row.email,
    type: row.type,
    status: row.status,
    locale: row.locale,
    fullName: profile ? `${profile.lastName} ${profile.firstName}` : null,
    profileId: profile?.id ?? null,
    // У студента позиций нет по построению: права даёт только позиция сотрудника.
    roles: (row.employee?.positions ?? []).map(({ position }) => toRole(position)).sort(byName),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
};
