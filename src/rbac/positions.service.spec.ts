import { ConflictException, NotFoundException } from '@nestjs/common';

import { BusinessRuleException, SortOrder } from '../common';
import { PositionQueryDto, PositionSortField } from './dto';
import type { PositionDetailRow, PositionsRepository } from './positions.repository';
import { PositionsService } from './positions.service';

const POSITION_ID = '11111111-1111-1111-1111-111111111111';
const DIRECTOR_ID = '22222222-2222-2222-2222-222222222222';

const row = (overrides: Partial<PositionDetailRow> = {}): PositionDetailRow => ({
  id: POSITION_ID,
  name: 'Manager',
  description: 'Менеджер',
  isSystem: false,
  createdAt: new Date('2026-07-26T10:00:00.000Z'),
  _count: { permissions: 2, employees: 0 },
  permissions: [
    { permission: { code: 'Permission.Students.Views' } },
    { permission: { code: 'Permission.Groups.Views' } },
  ],
  ...overrides,
});

// Настоящий экземпляр DTO, а не литерал: `skip`/`take` — вычисляемые геттеры,
// и подделанные значения скрыли бы ошибку в переводе страницы в окно выборки.
const query = (overrides: Partial<PositionQueryDto> = {}): PositionQueryDto =>
  Object.assign(new PositionQueryDto(), overrides);

describe('PositionsService', () => {
  let repository: jest.Mocked<
    Pick<
      PositionsRepository,
      | 'findMany'
      | 'findById'
      | 'findByName'
      | 'findPermissionsByCodes'
      | 'create'
      | 'update'
      | 'delete'
    >
  >;
  let service: PositionsService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findById: jest.fn().mockResolvedValue(row()),
      findByName: jest.fn().mockResolvedValue(null),
      findPermissionsByCodes: jest
        .fn()
        .mockImplementation((codes: string[]) =>
          Promise.resolve(codes.map((code) => ({ id: `perm-${code}`, code }))),
        ),
      create: jest.fn().mockImplementation(() => Promise.resolve(row())),
      update: jest.fn().mockImplementation(() => Promise.resolve(row())),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    service = new PositionsService(repository as unknown as PositionsRepository);
  });

  describe('Список и карточка', () => {
    it('отдаёт постраничный список со счётчиками', async () => {
      const result = await service.findAll(query());

      expect(result.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(result.items[0]).toMatchObject({
        name: 'Manager',
        permissionsCount: 2,
        employeesCount: 0,
        createdAt: '2026-07-26T10:00:00.000Z',
      });
      // Список не тянет коды прав — только счётчик.
      expect(result.items[0]).not.toHaveProperty('permissions');
    });

    it('передаёт в репозиторий поиск, сортировку и окно страницы', async () => {
      await service.findAll(query({ search: 'mana', order: SortOrder.Desc, page: 3, limit: 10 }));

      expect(repository.findMany).toHaveBeenCalledWith({
        search: 'mana',
        sort: PositionSortField.Name,
        order: SortOrder.Desc,
        skip: 20,
        take: 10,
      });
    });

    it('карточка отдаёт коды прав по алфавиту', async () => {
      const position = await service.findOne(POSITION_ID);

      expect(position.permissions).toEqual([
        'Permission.Groups.Views',
        'Permission.Students.Views',
      ]);
    });

    it('404 на неизвестную позицию', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findOne(POSITION_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('Создание', () => {
    it('переводит коды прав в идентификаторы связок', async () => {
      await service.create({
        name: 'Accountant',
        permissions: ['Permission.Students.Views', 'Permission.Groups.Views'],
      });

      expect(repository.create).toHaveBeenCalledWith({
        name: 'Accountant',
        description: null,
        permissionIds: ['perm-Permission.Students.Views', 'perm-Permission.Groups.Views'],
      });
    });

    it('позицию можно создать без прав', async () => {
      await service.create({ name: 'Intern' });

      expect(repository.create).toHaveBeenCalledWith({
        name: 'Intern',
        description: null,
        permissionIds: [],
      });
      expect(repository.findPermissionsByCodes).not.toHaveBeenCalled();
    });

    it('409 на занятое название без учёта регистра', async () => {
      repository.findByName.mockResolvedValue({ id: DIRECTOR_ID, name: 'Director' });

      await expect(service.create({ name: 'director' })).rejects.toBeInstanceOf(ConflictException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('422 на права раздела Accounting: они только у Director (ТЗ 3.2)', async () => {
      await expect(
        service.create({
          name: 'Accountant',
          permissions: ['Permission.Students.Views', 'Permission.Accounting.Views'],
        }),
      ).rejects.toBeInstanceOf(BusinessRuleException);

      expect(repository.create).not.toHaveBeenCalled();
    });

    it('422, если права нет в таблице каталога', async () => {
      repository.findPermissionsByCodes.mockResolvedValue([]);

      await expect(
        service.create({ name: 'Manager', permissions: ['Permission.Students.Views'] }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
    });
  });

  describe('Правка', () => {
    it('заменяет набор галочек целиком', async () => {
      await service.update(POSITION_ID, { permissions: ['Permission.Groups.Views'] });

      expect(repository.update).toHaveBeenCalledWith(POSITION_ID, {
        name: undefined,
        description: undefined,
        permissionIds: ['perm-Permission.Groups.Views'],
      });
    });

    it('без поля permissions права не трогаются', async () => {
      await service.update(POSITION_ID, { description: 'Новое описание' });

      expect(repository.update).toHaveBeenCalledWith(POSITION_ID, {
        name: undefined,
        description: 'Новое описание',
        permissionIds: undefined,
      });
    });

    it('пустая строка очищает описание', async () => {
      await service.update(POSITION_ID, { description: '' });

      expect(repository.update).toHaveBeenCalledWith(
        POSITION_ID,
        expect.objectContaining({ description: null }),
      );
    });

    it('переименование в собственное название конфликтом не считается', async () => {
      repository.findByName.mockResolvedValue({ id: POSITION_ID, name: 'manager' });

      await expect(service.update(POSITION_ID, { name: 'Manager' })).resolves.toMatchObject({
        name: 'Manager',
      });
    });

    it('422 на правку системной позиции', async () => {
      repository.findById.mockResolvedValue(
        row({ id: DIRECTOR_ID, name: 'Director', isSystem: true }),
      );

      await expect(service.update(DIRECTOR_ID, { permissions: [] })).rejects.toBeInstanceOf(
        BusinessRuleException,
      );

      expect(repository.update).not.toHaveBeenCalled();
    });

    it('422 на выдачу прав Accounting обычной позиции', async () => {
      await expect(
        service.update(POSITION_ID, { permissions: ['Permission.Accounting.ManageSalary'] }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
    });
  });

  describe('Удаление', () => {
    it('удаляет свободную позицию и возвращает её название', async () => {
      await expect(service.remove(POSITION_ID)).resolves.toEqual({
        id: POSITION_ID,
        name: 'Manager',
      });
      expect(repository.delete).toHaveBeenCalledWith(POSITION_ID);
    });

    it('409, если позицию занимают сотрудники', async () => {
      repository.findById.mockResolvedValue(row({ _count: { permissions: 2, employees: 3 } }));

      await expect(service.remove(POSITION_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('422 на удаление системной позиции', async () => {
      repository.findById.mockResolvedValue(row({ isSystem: true, name: 'Director' }));

      await expect(service.remove(POSITION_ID)).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('404 на неизвестную позицию', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.remove(POSITION_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
