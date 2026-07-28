import { ConflictException, NotFoundException } from '@nestjs/common';
import { DirectoryStatus } from '@prisma/client';

import { SortOrder } from '../common';
import type { AppConfigService } from '../config';
import { PhoneService } from '../phone';
import type { BranchesRepository, BranchRow } from './branches.repository';
import { BranchesService } from './branches.service';
import { BranchQueryDto, BranchSortField } from './dto';

const BRANCH_ID = '11111111-1111-1111-1111-111111111111';

const row = (overrides: Partial<BranchRow> = {}): BranchRow => ({
  id: BRANCH_ID,
  name: 'Sadbarg',
  city: 'Душанбе',
  district: 'Сино',
  address: 'ул. Рудаки, 105',
  phone: '+992372211122',
  description: null,
  status: DirectoryStatus.ACTIVE,
  createdAt: new Date('2026-07-27T10:00:00.000Z'),
  _count: { rooms: 0, groups: 0, students: 0, employees: 0, leads: 0 },
  ...overrides,
});

// Настоящий экземпляр DTO, а не литерал: `skip`/`take` — вычисляемые геттеры,
// и подделанные значения скрыли бы ошибку в переводе страницы в окно выборки.
const query = (overrides: Partial<BranchQueryDto> = {}): BranchQueryDto =>
  Object.assign(new BranchQueryDto(), overrides);

describe('BranchesService', () => {
  let repository: jest.Mocked<
    Pick<
      BranchesRepository,
      'findMany' | 'findById' | 'findByName' | 'create' | 'update' | 'delete'
    >
  >;
  let service: BranchesService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findById: jest.fn().mockResolvedValue(row()),
      findByName: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(() => Promise.resolve(row())),
      update: jest.fn().mockImplementation(() => Promise.resolve(row())),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    const phones = new PhoneService({ defaultPhoneRegion: 'TJ' } as AppConfigService);
    service = new BranchesService(repository as unknown as BranchesRepository, phones);
  });

  describe('Список и карточка', () => {
    it('отдаёт постраничный список со счётчиками привязанных записей', async () => {
      repository.findMany.mockResolvedValue({
        rows: [row({ _count: { rooms: 4, groups: 7, students: 120, employees: 9, leads: 0 } })],
        total: 1,
      });

      const result = await service.findAll(query());

      expect(result.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(result.items[0]).toMatchObject({
        name: 'Sadbarg',
        roomsCount: 4,
        groupsCount: 7,
        studentsCount: 120,
        employeesCount: 9,
        createdAt: '2026-07-27T10:00:00.000Z',
      });
    });

    it('передаёт репозиторию окно страницы и фильтр статуса', async () => {
      await service.findAll(
        query({
          page: 3,
          limit: 10,
          status: DirectoryStatus.INACTIVE,
          sort: BranchSortField.City,
          order: SortOrder.Desc,
        }),
      );

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20,
          take: 10,
          status: DirectoryStatus.INACTIVE,
          sort: BranchSortField.City,
          order: SortOrder.Desc,
        }),
      );
    });

    it('404 на неизвестный филиал', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findOne(BRANCH_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('Создание', () => {
    it('нормализует телефон в E.164 и пишет остальные поля', async () => {
      await service.create({
        name: 'Profsous',
        city: 'Худжанд',
        address: 'ул. Ленина, 1',
        phone: '901234567',
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Profsous', phone: '+992901234567' }),
      );
    });

    it('без телефона и района пишет null, а не undefined', async () => {
      await service.create({ name: 'Profsous', city: 'Худжанд', address: 'ул. Ленина, 1' });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ phone: null, district: null, description: null }),
      );
    });

    it('409 на тёзку без учёта регистра', async () => {
      repository.findByName.mockResolvedValue({ id: 'other', name: 'Sadbarg' });

      await expect(
        service.create({ name: 'sadbarg', city: 'Душанбе', address: 'ул. Рудаки, 105' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('некорректный телефон отвергается до записи', async () => {
      await expect(
        service.create({
          name: 'Profsous',
          city: 'Худжанд',
          address: 'ул. Ленина, 1',
          phone: '12',
        }),
      ).rejects.toThrow();
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('Правка', () => {
    it('не переданные поля остаются undefined — Prisma их пропустит', async () => {
      await service.update(BRANCH_ID, { city: 'Худжанд' });

      expect(repository.update).toHaveBeenCalledWith(BRANCH_ID, {
        name: undefined,
        city: 'Худжанд',
        district: undefined,
        address: undefined,
        phone: undefined,
        description: undefined,
        status: undefined,
      });
    });

    it('пустая строка очищает описание, телефон и район', async () => {
      await service.update(BRANCH_ID, { description: '', phone: '', district: '' });

      expect(repository.update).toHaveBeenCalledWith(
        BRANCH_ID,
        expect.objectContaining({ description: null, phone: null, district: null }),
      );
    });

    it('переименование в собственное название не считается конфликтом', async () => {
      repository.findByName.mockResolvedValue({ id: BRANCH_ID, name: 'Sadbarg' });

      await expect(service.update(BRANCH_ID, { name: 'sadbarg' })).resolves.toMatchObject({
        id: BRANCH_ID,
      });
    });

    it('409 на переименование в занятое название', async () => {
      repository.findByName.mockResolvedValue({ id: 'other', name: 'Profsous' });

      await expect(service.update(BRANCH_ID, { name: 'Profsous' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('404 на правку неизвестного филиала', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.update(BRANCH_ID, { city: 'Худжанд' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('Удаление', () => {
    it('удаляет пустой филиал и называет удалённое', async () => {
      await expect(service.remove(BRANCH_ID)).resolves.toEqual({
        id: BRANCH_ID,
        name: 'Sadbarg',
      });
      expect(repository.delete).toHaveBeenCalledWith(BRANCH_ID);
    });

    it('409, если к филиалу привязаны студенты — с перечислением причин', async () => {
      repository.findById.mockResolvedValue(
        row({ _count: { rooms: 2, groups: 0, students: 15, employees: 0, leads: 0 } }),
      );

      const error = await service.remove(BRANCH_ID).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toContain('аудитории (2)');
      expect((error as ConflictException).message).toContain('студенты (15)');
      // Сотрудников и групп нет — про них в сообщении быть не должно.
      expect((error as ConflictException).message).not.toContain('сотрудники');
      expect((error as ConflictException).message).not.toContain('группы');
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('409, если в филиал записаны лиды (ТЗ 5.7)', async () => {
      repository.findById.mockResolvedValue(
        row({ _count: { rooms: 0, groups: 0, students: 0, employees: 0, leads: 5 } }),
      );

      const error = await service.remove(BRANCH_ID).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toContain('лиды (5)');
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('409, если к филиалу привязаны только сотрудники', async () => {
      repository.findById.mockResolvedValue(
        row({ _count: { rooms: 0, groups: 0, students: 0, employees: 3, leads: 0 } }),
      );

      await expect(service.remove(BRANCH_ID)).rejects.toBeInstanceOf(ConflictException);
    });

    it('409, если в филиале набраны группы (ТЗ 5.5 — связь RESTRICT)', async () => {
      repository.findById.mockResolvedValue(
        row({ _count: { rooms: 0, groups: 4, students: 0, employees: 0, leads: 0 } }),
      );

      const error = await service.remove(BRANCH_ID).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toContain('группы (4)');
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('404 на удаление неизвестного филиала', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.remove(BRANCH_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
