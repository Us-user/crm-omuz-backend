import { ConflictException, NotFoundException } from '@nestjs/common';
import { EmployeeStatus, GroupMentorRole } from '@prisma/client';

import { BusinessRuleException, SortOrder } from '../common';
import { GroupMentorQueryDto, GroupMentorSortField } from './dto';
import type { GroupMentorRow, GroupMentorsRepository } from './group-mentors.repository';
import { GroupMentorsService } from './group-mentors.service';

const GROUP_ID = '11111111-1111-1111-1111-111111111111';
const EMPLOYEE_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_EMPLOYEE_ID = '33333333-3333-3333-3333-333333333333';

const employee = (
  overrides: Partial<GroupMentorRow['employee']> = {},
): GroupMentorRow['employee'] => ({
  id: EMPLOYEE_ID,
  firstName: 'Фаррух',
  lastName: 'Раҳимов',
  middleName: null,
  phone: '+992901234567',
  photoUrl: null,
  status: EmployeeStatus.ACTIVE,
  ...overrides,
});

const row = (overrides: Partial<GroupMentorRow> = {}): GroupMentorRow => ({
  groupId: GROUP_ID,
  employeeId: EMPLOYEE_ID,
  role: GroupMentorRole.TEACHING,
  assignedAt: new Date('2026-07-27T10:00:00.000Z'),
  employee: employee(),
  ...overrides,
});

// Настоящий экземпляр DTO, а не литерал: `skip`/`take` — вычисляемые геттеры,
// и подделанные значения скрыли бы ошибку в переводе страницы в окно выборки.
const query = (overrides: Partial<GroupMentorQueryDto> = {}): GroupMentorQueryDto =>
  Object.assign(new GroupMentorQueryDto(), overrides);

describe('GroupMentorsService', () => {
  let repository: jest.Mocked<
    Pick<
      GroupMentorsRepository,
      'findMany' | 'findGroup' | 'findEmployee' | 'findOne' | 'create' | 'updateRole' | 'delete'
    >
  >;
  let service: GroupMentorsService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findGroup: jest.fn().mockResolvedValue({ id: GROUP_ID, name: 'Frontend-1' }),
      findEmployee: jest.fn().mockResolvedValue({
        id: EMPLOYEE_ID,
        firstName: 'Фаррух',
        lastName: 'Раҳимов',
        status: EmployeeStatus.ACTIVE,
      }),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(() => Promise.resolve(row())),
      updateRole: jest.fn().mockImplementation(() => Promise.resolve(row())),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    service = new GroupMentorsService(repository as unknown as GroupMentorsRepository);
  });

  describe('Список менторов', () => {
    it('отдаёт ментора вместе с профилем сотрудника', async () => {
      const result = await service.findAll(GROUP_ID, query());

      expect(result.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(result.items[0]).toMatchObject({
        groupId: GROUP_ID,
        role: GroupMentorRole.TEACHING,
        assignedAt: '2026-07-27T10:00:00.000Z',
        employee: { id: EMPLOYEE_ID, lastName: 'Раҳимов', phone: '+992901234567' },
      });
    });

    it('передаёт репозиторию окно страницы, фильтр роли и сортировку', async () => {
      await service.findAll(
        GROUP_ID,
        query({
          page: 3,
          limit: 5,
          role: GroupMentorRole.SUPPORT,
          search: 'Раҳимов',
          sort: GroupMentorSortField.AssignedAt,
          order: SortOrder.Desc,
        }),
      );

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          groupId: GROUP_ID,
          skip: 10,
          take: 5,
          role: GroupMentorRole.SUPPORT,
          search: 'Раҳимов',
          sort: GroupMentorSortField.AssignedAt,
          order: SortOrder.Desc,
        }),
      );
    });

    it('по умолчанию сортирует по имени по возрастанию', async () => {
      await service.findAll(GROUP_ID, query());

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ sort: GroupMentorSortField.Name, order: SortOrder.Asc }),
      );
    });

    it('неизвестная группа — 404, список не запрашивается', async () => {
      repository.findGroup.mockResolvedValue(null);

      await expect(service.findAll(GROUP_ID, query())).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findMany).not.toHaveBeenCalled();
    });

    it('незаполненное отчество и фото отдаются как null', async () => {
      repository.findMany.mockResolvedValue({ rows: [row()], total: 1 });

      const result = await service.findAll(GROUP_ID, query());

      expect(result.items[0].employee.middleName).toBeNull();
      expect(result.items[0].employee.photoUrl).toBeNull();
    });
  });

  describe('Назначение ментора (ТЗ 5.5)', () => {
    it('назначает сотрудника с ролью из запроса', async () => {
      repository.create.mockResolvedValue(row({ role: GroupMentorRole.SUPPORT }));

      const mentor = await service.assign(GROUP_ID, {
        employeeId: EMPLOYEE_ID,
        role: GroupMentorRole.SUPPORT,
      });

      expect(repository.create).toHaveBeenCalledWith({
        groupId: GROUP_ID,
        employeeId: EMPLOYEE_ID,
        role: GroupMentorRole.SUPPORT,
      });
      expect(mentor.role).toBe(GroupMentorRole.SUPPORT);
    });

    it('без роли в теле её выбирает БД (значение по умолчанию Teaching)', async () => {
      await service.assign(GROUP_ID, { employeeId: EMPLOYEE_ID });

      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ role: undefined }));
    });

    it('позиция «Mentor» не требуется: сотрудник назначается без обращения к правам', async () => {
      const mentor = await service.assign(GROUP_ID, { employeeId: EMPLOYEE_ID });

      expect(mentor.employee.id).toBe(EMPLOYEE_ID);
      // Единственная проверка сотрудника — существование и статус: если бы
      // правило смотрело на позиции, здесь понадобился бы ещё один запрос.
      expect(repository.findEmployee).toHaveBeenCalledWith(EMPLOYEE_ID);
    });

    it('неизвестная группа — 404, сотрудник даже не ищется', async () => {
      repository.findGroup.mockResolvedValue(null);

      await expect(service.assign(GROUP_ID, { employeeId: EMPLOYEE_ID })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.findEmployee).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('несуществующий сотрудник — 422, а не 404: он пришёл в теле', async () => {
      repository.findEmployee.mockResolvedValue(null);

      await expect(service.assign(GROUP_ID, { employeeId: EMPLOYEE_ID })).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('выведенный из штата сотрудник ментором не назначается — 422', async () => {
      repository.findEmployee.mockResolvedValue({
        id: EMPLOYEE_ID,
        firstName: 'Фаррух',
        lastName: 'Раҳимов',
        status: EmployeeStatus.INACTIVE,
      });

      await expect(service.assign(GROUP_ID, { employeeId: EMPLOYEE_ID })).rejects.toThrow(
        'Сотрудник выведен из штата',
      );
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('повторное назначение того же сотрудника — 409 с указанием текущей роли', async () => {
      repository.findOne.mockResolvedValue(row({ role: GroupMentorRole.SUPPORT }));

      await expect(service.assign(GROUP_ID, { employeeId: EMPLOYEE_ID })).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(service.assign(GROUP_ID, { employeeId: EMPLOYEE_ID })).rejects.toThrow(
        /SUPPORT/,
      );
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('второй ментор в той же группе — обычное дело (ТЗ 5.5: их несколько)', async () => {
      repository.findEmployee.mockResolvedValue({
        id: OTHER_EMPLOYEE_ID,
        firstName: 'Нигина',
        lastName: 'Каримова',
        status: EmployeeStatus.ACTIVE,
      });
      repository.create.mockResolvedValue(
        row({
          employeeId: OTHER_EMPLOYEE_ID,
          role: GroupMentorRole.SUPPORT,
          employee: employee({ id: OTHER_EMPLOYEE_ID, firstName: 'Нигина', lastName: 'Каримова' }),
        }),
      );

      const mentor = await service.assign(GROUP_ID, {
        employeeId: OTHER_EMPLOYEE_ID,
        role: GroupMentorRole.SUPPORT,
      });

      expect(mentor.employee.id).toBe(OTHER_EMPLOYEE_ID);
    });
  });

  describe('Смена роли', () => {
    it('переводит ментора из Support в Teaching', async () => {
      repository.findOne.mockResolvedValue(row({ role: GroupMentorRole.SUPPORT }));
      repository.updateRole.mockResolvedValue(row({ role: GroupMentorRole.TEACHING }));

      const mentor = await service.updateRole(GROUP_ID, EMPLOYEE_ID, {
        role: GroupMentorRole.TEACHING,
      });

      expect(repository.updateRole).toHaveBeenCalledWith(
        GROUP_ID,
        EMPLOYEE_ID,
        GroupMentorRole.TEACHING,
      );
      expect(mentor.role).toBe(GroupMentorRole.TEACHING);
    });

    it('та же роль в запросе — в БД не пишем', async () => {
      repository.findOne.mockResolvedValue(row({ role: GroupMentorRole.TEACHING }));

      const mentor = await service.updateRole(GROUP_ID, EMPLOYEE_ID, {
        role: GroupMentorRole.TEACHING,
      });

      expect(repository.updateRole).not.toHaveBeenCalled();
      expect(mentor.role).toBe(GroupMentorRole.TEACHING);
    });

    it('не назначенный сотрудник — 404', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.updateRole(GROUP_ID, EMPLOYEE_ID, { role: GroupMentorRole.SUPPORT }),
      ).rejects.toThrow('Ментор не назначен на эту группу');
      expect(repository.updateRole).not.toHaveBeenCalled();
    });

    it('неизвестная группа отличима от неназначенного ментора', async () => {
      repository.findGroup.mockResolvedValue(null);

      await expect(
        service.updateRole(GROUP_ID, EMPLOYEE_ID, { role: GroupMentorRole.SUPPORT }),
      ).rejects.toThrow('Группа не найдена');
    });

    it('выведенный из штата ментор роль сменить может: история группы не переписывается', async () => {
      repository.findOne.mockResolvedValue(
        row({
          role: GroupMentorRole.TEACHING,
          employee: employee({ status: EmployeeStatus.INACTIVE }),
        }),
      );
      repository.updateRole.mockResolvedValue(
        row({
          role: GroupMentorRole.SUPPORT,
          employee: employee({ status: EmployeeStatus.INACTIVE }),
        }),
      );

      const mentor = await service.updateRole(GROUP_ID, EMPLOYEE_ID, {
        role: GroupMentorRole.SUPPORT,
      });

      expect(mentor.role).toBe(GroupMentorRole.SUPPORT);
      expect(mentor.employee.status).toBe(EmployeeStatus.INACTIVE);
    });
  });

  describe('Снятие ментора', () => {
    it('снимает назначение и называет снятого', async () => {
      repository.findOne.mockResolvedValue(row());

      const removed = await service.remove(GROUP_ID, EMPLOYEE_ID);

      expect(repository.delete).toHaveBeenCalledWith(GROUP_ID, EMPLOYEE_ID);
      expect(removed).toEqual({
        groupId: GROUP_ID,
        employeeId: EMPLOYEE_ID,
        fullName: 'Раҳимов Фаррух',
      });
    });

    it('не назначенный сотрудник — 404, ничего не удаляется', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.remove(GROUP_ID, EMPLOYEE_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('неизвестная группа — 404 про группу, а не про ментора', async () => {
      repository.findGroup.mockResolvedValue(null);

      await expect(service.remove(GROUP_ID, EMPLOYEE_ID)).rejects.toThrow('Группа не найдена');
      expect(repository.delete).not.toHaveBeenCalled();
    });
  });
});
