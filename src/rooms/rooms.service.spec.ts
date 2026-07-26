import { ConflictException, NotFoundException } from '@nestjs/common';
import { DirectoryStatus } from '@prisma/client';

import { BusinessRuleException } from '../common';
import { RoomQueryDto } from './dto';
import type { RoomRow, RoomsRepository } from './rooms.repository';
import { RoomsService } from './rooms.service';

const ROOM_ID = '11111111-1111-1111-1111-111111111111';
const BRANCH_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_BRANCH_ID = '33333333-3333-3333-3333-333333333333';

const row = (overrides: Partial<RoomRow> = {}): RoomRow => ({
  id: ROOM_ID,
  name: '101',
  branch: { id: BRANCH_ID, name: 'Sadbarg' },
  capacity: 16,
  floor: 1,
  description: null,
  status: DirectoryStatus.ACTIVE,
  createdAt: new Date('2026-07-27T10:00:00.000Z'),
  ...overrides,
});

const query = (overrides: Partial<RoomQueryDto> = {}): RoomQueryDto =>
  Object.assign(new RoomQueryDto(), overrides);

describe('RoomsService', () => {
  let repository: jest.Mocked<
    Pick<
      RoomsRepository,
      'findMany' | 'findById' | 'findByName' | 'findBranch' | 'create' | 'update' | 'delete'
    >
  >;
  let service: RoomsService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findById: jest.fn().mockResolvedValue(row()),
      findByName: jest.fn().mockResolvedValue(null),
      findBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID, name: 'Sadbarg' }),
      create: jest.fn().mockImplementation(() => Promise.resolve(row())),
      update: jest.fn().mockImplementation(() => Promise.resolve(row())),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    service = new RoomsService(repository as unknown as RoomsRepository);
  });

  describe('Список и карточка', () => {
    it('отдаёт аудиторию вместе с её филиалом', async () => {
      const result = await service.findAll(query());

      expect(result.items[0]).toMatchObject({
        name: '101',
        branch: { id: BRANCH_ID, name: 'Sadbarg' },
        capacity: 16,
        createdAt: '2026-07-27T10:00:00.000Z',
      });
    });

    it('передаёт фильтр по филиалу и окно страницы', async () => {
      await service.findAll(query({ page: 2, limit: 5, branchId: BRANCH_ID }));

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 5, branchId: BRANCH_ID }),
      );
    });

    it('404 на неизвестную аудиторию', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findOne(ROOM_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('Создание', () => {
    it('пишет аудиторию с филиалом, вместимостью и этажом', async () => {
      await service.create({ branchId: BRANCH_ID, name: '202', capacity: 20, floor: 2 });

      expect(repository.create).toHaveBeenCalledWith({
        branchId: BRANCH_ID,
        name: '202',
        capacity: 20,
        floor: 2,
        description: null,
        status: undefined,
      });
    });

    it('без вместимости и этажа пишет null, а не undefined', async () => {
      await service.create({ branchId: BRANCH_ID, name: '202' });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ capacity: null, floor: null }),
      );
    });

    it('422 на несуществующий филиал в теле запроса', async () => {
      repository.findBranch.mockResolvedValue(null);

      await expect(
        service.create({ branchId: OTHER_BRANCH_ID, name: '202' }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('409 на тёзку внутри того же филиала, без учёта регистра', async () => {
      repository.findByName.mockResolvedValue({ id: 'other', name: 'Лаборатория' });

      await expect(
        service.create({ branchId: BRANCH_ID, name: 'лаборатория' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('тёзка ищется именно в филиале запроса', async () => {
      await service.create({ branchId: OTHER_BRANCH_ID, name: '101' });

      expect(repository.findByName).toHaveBeenCalledWith(OTHER_BRANCH_ID, '101');
    });
  });

  describe('Правка', () => {
    it('не переданные поля остаются undefined', async () => {
      await service.update(ROOM_ID, { capacity: 24 });

      expect(repository.update).toHaveBeenCalledWith(ROOM_ID, {
        branchId: undefined,
        name: undefined,
        capacity: 24,
        floor: undefined,
        description: undefined,
        status: undefined,
      });
    });

    it('пустая строка очищает описание', async () => {
      await service.update(ROOM_ID, { description: '' });

      expect(repository.update).toHaveBeenCalledWith(
        ROOM_ID,
        expect.objectContaining({ description: null }),
      );
    });

    it('без смены названия и филиала тёзку не ищет', async () => {
      await service.update(ROOM_ID, { capacity: 24 });

      expect(repository.findByName).not.toHaveBeenCalled();
    });

    it('при переносе в другой филиал тёзка проверяется в филиале назначения', async () => {
      await service.update(ROOM_ID, { branchId: OTHER_BRANCH_ID });

      expect(repository.findBranch).toHaveBeenCalledWith(OTHER_BRANCH_ID);
      // Название не менялось — берётся текущее, но искать его надо уже там.
      expect(repository.findByName).toHaveBeenCalledWith(OTHER_BRANCH_ID, '101');
    });

    it('422 на перенос в несуществующий филиал', async () => {
      repository.findBranch.mockResolvedValue(null);

      await expect(service.update(ROOM_ID, { branchId: OTHER_BRANCH_ID })).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('переименование в собственное название не считается конфликтом', async () => {
      repository.findByName.mockResolvedValue({ id: ROOM_ID, name: '101' });

      await expect(service.update(ROOM_ID, { name: '101' })).resolves.toMatchObject({
        id: ROOM_ID,
      });
    });

    it('409 на переименование в занятое в этом же филиале название', async () => {
      repository.findByName.mockResolvedValue({ id: 'other', name: '202' });

      await expect(service.update(ROOM_ID, { name: '202' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('404 на правку неизвестной аудитории', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.update(ROOM_ID, { capacity: 24 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('Удаление', () => {
    it('удаляет аудиторию и называет удалённое', async () => {
      await expect(service.remove(ROOM_ID)).resolves.toEqual({ id: ROOM_ID, name: '101' });
      expect(repository.delete).toHaveBeenCalledWith(ROOM_ID);
    });

    it('404 на удаление неизвестной аудитории', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.remove(ROOM_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.delete).not.toHaveBeenCalled();
    });
  });
});
