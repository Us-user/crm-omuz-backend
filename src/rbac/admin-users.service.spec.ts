import { NotFoundException } from '@nestjs/common';
import { AccountStatus, AccountType, Locale } from '@prisma/client';

import { BusinessRuleException, SortOrder } from '../common';
import type { AccountForRoles, AdminUserRow, AdminUsersRepository } from './admin-users.repository';
import { AdminUsersService } from './admin-users.service';
import { AdminUserQueryDto, AdminUserSortField } from './dto';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const EMPLOYEE_ID = '22222222-2222-2222-2222-222222222222';
const MANAGER_ID = '33333333-3333-3333-3333-333333333333';
const DIRECTOR_ID = '44444444-4444-4444-4444-444444444444';

// Настоящий экземпляр DTO: `skip`/`take` считаются из `page`/`limit` геттерами.
const query = (overrides: Partial<AdminUserQueryDto> = {}): AdminUserQueryDto =>
  Object.assign(new AdminUserQueryDto(), overrides);

const account = (overrides: Partial<AdminUserRow> = {}): AdminUserRow => ({
  id: ACCOUNT_ID,
  phone: '+992901234567',
  email: 'farrukh@example.tj',
  type: AccountType.EMPLOYEE,
  status: AccountStatus.ACTIVE,
  locale: Locale.RU,
  lastLoginAt: null,
  createdAt: new Date('2026-07-01T08:00:00.000Z'),
  student: null,
  employee: {
    id: EMPLOYEE_ID,
    firstName: 'Фаррух',
    lastName: 'Раҳимов',
    positions: [{ position: { id: MANAGER_ID, name: 'Manager', isSystem: false } }],
  },
  ...overrides,
});

const forRoles = (overrides: Partial<AccountForRoles> = {}): AccountForRoles => ({
  id: ACCOUNT_ID,
  type: AccountType.EMPLOYEE,
  employee: { id: EMPLOYEE_ID, positionIds: [MANAGER_ID] },
  ...overrides,
});

describe('AdminUsersService', () => {
  let repository: jest.Mocked<
    Pick<
      AdminUsersRepository,
      | 'findMany'
      | 'findAccountForRoles'
      | 'findPositionsByIds'
      | 'findEmployeeRoles'
      | 'assignPositions'
      | 'removePositions'
      | 'countPositionAssignments'
    >
  >;
  let service: AdminUsersService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [account()], total: 1 }),
      findAccountForRoles: jest.fn().mockResolvedValue(forRoles()),
      findPositionsByIds: jest
        .fn()
        .mockResolvedValue([{ id: MANAGER_ID, name: 'Manager', isSystem: false }]),
      findEmployeeRoles: jest
        .fn()
        .mockResolvedValue([{ id: MANAGER_ID, name: 'Manager', isSystem: false }]),
      assignPositions: jest.fn().mockResolvedValue(1),
      removePositions: jest.fn().mockResolvedValue(1),
      countPositionAssignments: jest.fn().mockResolvedValue(2),
    };

    service = new AdminUsersService(repository as unknown as AdminUsersRepository);
  });

  describe('Список аккаунтов (ТЗ 5.15)', () => {
    it('склеивает имя из профиля и отдаёт роли сотрудника', async () => {
      const result = await service.findAll(query());

      expect(result.items[0]).toMatchObject({
        phone: '+992901234567',
        type: AccountType.EMPLOYEE,
        fullName: 'Раҳимов Фаррух',
        profileId: EMPLOYEE_ID,
        roles: [{ id: MANAGER_ID, name: 'Manager', isSystem: false }],
        createdAt: '2026-07-01T08:00:00.000Z',
        lastLoginAt: null,
      });
    });

    it('у студента ролей нет, а имя берётся из профиля студента', async () => {
      repository.findMany.mockResolvedValue({
        rows: [
          account({
            type: AccountType.STUDENT,
            employee: null,
            student: { id: 'student-1', firstName: 'Нилуфар', lastName: 'Каримова' },
          }),
        ],
        total: 1,
      });

      const result = await service.findAll(query());

      expect(result.items[0]).toMatchObject({
        fullName: 'Каримова Нилуфар',
        profileId: 'student-1',
        roles: [],
      });
    });

    it('аккаунт без профиля не ломает выдачу', async () => {
      repository.findMany.mockResolvedValue({
        rows: [account({ employee: null, student: null })],
        total: 1,
      });

      const result = await service.findAll(query());

      expect(result.items[0]).toMatchObject({ fullName: null, profileId: null, roles: [] });
    });

    it('передаёт фильтры и окно страницы в репозиторий', async () => {
      await service.findAll(
        query({
          type: AccountType.EMPLOYEE,
          status: AccountStatus.BLOCKED,
          page: 2,
          search: '992',
        }),
      );

      expect(repository.findMany).toHaveBeenCalledWith({
        search: '992',
        type: AccountType.EMPLOYEE,
        status: AccountStatus.BLOCKED,
        sort: AdminUserSortField.CreatedAt,
        order: SortOrder.Desc,
        skip: 20,
        take: 20,
      });
    });
  });

  describe('Назначение ролей', () => {
    it('назначает позиции профилю сотрудника и возвращает итоговый список', async () => {
      const result = await service.assignRoles(ACCOUNT_ID, { positionIds: [MANAGER_ID] });

      expect(repository.assignPositions).toHaveBeenCalledWith(EMPLOYEE_ID, [MANAGER_ID]);
      expect(result).toMatchObject({
        accountId: ACCOUNT_ID,
        employeeId: EMPLOYEE_ID,
        changed: 1,
        roles: [{ name: 'Manager' }],
      });
    });

    it('повторное назначение ничего не меняет (changed = 0)', async () => {
      repository.assignPositions.mockResolvedValue(0);

      const result = await service.assignRoles(ACCOUNT_ID, { positionIds: [MANAGER_ID] });

      expect(result.changed).toBe(0);
    });

    it('404 на неизвестный аккаунт', async () => {
      repository.findAccountForRoles.mockResolvedValue(null);

      await expect(
        service.assignRoles(ACCOUNT_ID, { positionIds: [MANAGER_ID] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('422 на аккаунт студента: права даёт только позиция сотрудника (ТЗ 3.2)', async () => {
      repository.findAccountForRoles.mockResolvedValue(
        forRoles({ type: AccountType.STUDENT, employee: null }),
      );

      await expect(
        service.assignRoles(ACCOUNT_ID, { positionIds: [MANAGER_ID] }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.assignPositions).not.toHaveBeenCalled();
    });

    it('422 на неизвестную позицию в теле запроса', async () => {
      repository.findPositionsByIds.mockResolvedValue([]);

      await expect(
        service.assignRoles(ACCOUNT_ID, { positionIds: [MANAGER_ID] }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.assignPositions).not.toHaveBeenCalled();
    });
  });

  describe('Снятие ролей', () => {
    it('снимает позицию', async () => {
      const result = await service.removeRoles(ACCOUNT_ID, { positionIds: [MANAGER_ID] });

      expect(repository.removePositions).toHaveBeenCalledWith(EMPLOYEE_ID, [MANAGER_ID]);
      expect(result.changed).toBe(1);
    });

    it('снятие непривязанной роли проходит без ошибки', async () => {
      repository.removePositions.mockResolvedValue(0);

      await expect(
        service.removeRoles(ACCOUNT_ID, { positionIds: [MANAGER_ID] }),
      ).resolves.toMatchObject({ changed: 0 });
    });

    it('422 на снятие Director с последнего руководителя', async () => {
      repository.findAccountForRoles.mockResolvedValue(
        forRoles({ employee: { id: EMPLOYEE_ID, positionIds: [DIRECTOR_ID] } }),
      );
      repository.findPositionsByIds.mockResolvedValue([
        { id: DIRECTOR_ID, name: 'Director', isSystem: true },
      ]);
      repository.countPositionAssignments.mockResolvedValue(1);

      await expect(
        service.removeRoles(ACCOUNT_ID, { positionIds: [DIRECTOR_ID] }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.removePositions).not.toHaveBeenCalled();
    });

    it('Director снимается, пока остаётся хотя бы один другой', async () => {
      repository.findAccountForRoles.mockResolvedValue(
        forRoles({ employee: { id: EMPLOYEE_ID, positionIds: [DIRECTOR_ID] } }),
      );
      repository.findPositionsByIds.mockResolvedValue([
        { id: DIRECTOR_ID, name: 'Director', isSystem: true },
      ]);
      repository.countPositionAssignments.mockResolvedValue(2);
      repository.findEmployeeRoles.mockResolvedValue([]);

      await expect(
        service.removeRoles(ACCOUNT_ID, { positionIds: [DIRECTOR_ID] }),
      ).resolves.toMatchObject({ roles: [] });
    });

    it('чужая позиция Director не запускает правило: сотрудник её и не занимал', async () => {
      repository.findPositionsByIds.mockResolvedValue([
        { id: DIRECTOR_ID, name: 'Director', isSystem: true },
      ]);
      repository.countPositionAssignments.mockResolvedValue(1);

      await expect(
        service.removeRoles(ACCOUNT_ID, { positionIds: [DIRECTOR_ID] }),
      ).resolves.toMatchObject({ changed: 1 });
      expect(repository.countPositionAssignments).not.toHaveBeenCalled();
    });

    it('позиция с именем Director, но не системная, правилом не защищена', async () => {
      // Правило опирается на `isSystem`, а не только на название: тёзку
      // создать нельзя (уникальность без учёта регистра), но подделка имени
      // не должна делать обычную позицию неснимаемой.
      repository.findAccountForRoles.mockResolvedValue(
        forRoles({ employee: { id: EMPLOYEE_ID, positionIds: [MANAGER_ID] } }),
      );
      repository.findPositionsByIds.mockResolvedValue([
        { id: MANAGER_ID, name: 'Director', isSystem: false },
      ]);

      await expect(
        service.removeRoles(ACCOUNT_ID, { positionIds: [MANAGER_ID] }),
      ).resolves.toMatchObject({ changed: 1 });
    });
  });
});
