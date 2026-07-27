import { ConflictException, NotFoundException } from '@nestjs/common';
import { DirectoryStatus, Prisma } from '@prisma/client';

import { SortOrder } from '../common';
import { MentorLevelQueryDto, MentorLevelSortField } from './dto';
import type { MentorLevelRow, MentorLevelsRepository } from './mentor-levels.repository';
import { MentorLevelsService } from './mentor-levels.service';

const LEVEL_ID = '11111111-1111-1111-1111-111111111111';

const row = (overrides: Partial<MentorLevelRow> = {}): MentorLevelRow => ({
  id: LEVEL_ID,
  name: 'Senior mentor',
  description: 'Ведёт группы и наставляет младших',
  hourlyRate: new Prisma.Decimal('45.50'),
  status: DirectoryStatus.ACTIVE,
  createdAt: new Date('2026-07-29T10:00:00.000Z'),
  _count: { history: 0 },
  ...overrides,
});

const query = (overrides: Partial<MentorLevelQueryDto> = {}): MentorLevelQueryDto =>
  Object.assign(new MentorLevelQueryDto(), overrides);

describe('MentorLevelsService', () => {
  let repository: jest.Mocked<
    Pick<
      MentorLevelsRepository,
      'findMany' | 'findById' | 'findByName' | 'create' | 'update' | 'delete'
    >
  >;
  let service: MentorLevelsService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findById: jest.fn().mockResolvedValue(row()),
      findByName: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(() => Promise.resolve(row())),
      update: jest.fn().mockImplementation(() => Promise.resolve(row())),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    service = new MentorLevelsService(repository as unknown as MentorLevelsRepository);
  });

  describe('Список и карточка', () => {
    it('переводит DECIMAL ставки в число без потери копеек', async () => {
      const result = await service.findAll(query());

      expect(result.items[0]?.hourlyRate).toBe(45.5);
      expect(typeof result.items[0]?.hourlyRate).toBe('number');
    });

    it('отдаёт число месяцев, в которых ступень проставлена', async () => {
      repository.findMany.mockResolvedValue({ rows: [row({ _count: { history: 12 } })], total: 1 });

      const result = await service.findAll(query());

      expect(result.items[0]?.historyCount).toBe(12);
    });

    it('передаёт окно страницы, фильтр статуса и поиск', async () => {
      await service.findAll(
        query({
          page: 2,
          limit: 5,
          search: 'senior',
          status: DirectoryStatus.INACTIVE,
          sort: MentorLevelSortField.Name,
          order: SortOrder.Desc,
        }),
      );

      expect(repository.findMany).toHaveBeenCalledWith({
        search: 'senior',
        status: DirectoryStatus.INACTIVE,
        sort: MentorLevelSortField.Name,
        order: SortOrder.Desc,
        skip: 5,
        take: 5,
      });
    });

    it('по умолчанию читает лестницу снизу вверх — по возрастанию ставки', async () => {
      await service.findAll(query());

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ sort: MentorLevelSortField.HourlyRate, order: SortOrder.Asc }),
      );
    });

    it('отдаёт карточку ступени', async () => {
      const level = await service.findOne(LEVEL_ID);

      expect(level).toMatchObject({ id: LEVEL_ID, name: 'Senior mentor', hourlyRate: 45.5 });
    });

    it('404 на неизвестную ступень', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findOne(LEVEL_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('Создание', () => {
    it('заводит ступень со ставкой и описанием', async () => {
      await service.create({
        name: 'Senior mentor',
        description: 'Ведёт группы',
        hourlyRate: 45.5,
      });

      expect(repository.create).toHaveBeenCalledWith({
        name: 'Senior mentor',
        description: 'Ведёт группы',
        hourlyRate: 45.5,
        status: undefined,
      });
    });

    it('пустое описание кладётся как null, а не как пустая строка', async () => {
      await service.create({ name: 'Junior mentor', description: '', hourlyRate: 20 });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ description: null }),
      );
    });

    it('принимает нулевую ставку: стажёр без оплаты — законное состояние', async () => {
      await service.create({ name: 'Intern', hourlyRate: 0 });

      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ hourlyRate: 0 }));
    });

    it('409 на тёзку без учёта регистра — ступень не создана', async () => {
      repository.findByName.mockResolvedValue({ id: 'other', name: 'Senior mentor' });

      await expect(
        service.create({ name: 'senior mentor', hourlyRate: 45 }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('Правка', () => {
    it('не переданные поля до БД не доходят', async () => {
      await service.update(LEVEL_ID, { hourlyRate: 50 });

      expect(repository.update).toHaveBeenCalledWith(LEVEL_ID, {
        name: undefined,
        description: undefined,
        hourlyRate: 50,
        status: undefined,
      });
    });

    it('пустая строка очищает описание', async () => {
      await service.update(LEVEL_ID, { description: '' });

      expect(repository.update).toHaveBeenCalledWith(
        LEVEL_ID,
        expect.objectContaining({ description: null }),
      );
    });

    it('переименование в себя — не конфликт', async () => {
      repository.findByName.mockResolvedValue({ id: LEVEL_ID, name: 'Senior mentor' });

      await expect(service.update(LEVEL_ID, { name: 'Senior Mentor' })).resolves.toBeDefined();
    });

    it('409 на чужое название', async () => {
      repository.findByName.mockResolvedValue({ id: 'other', name: 'Middle mentor' });

      await expect(service.update(LEVEL_ID, { name: 'middle mentor' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('без смены названия тёзку не ищет — лишнего запроса нет', async () => {
      await service.update(LEVEL_ID, { hourlyRate: 60 });

      expect(repository.findByName).not.toHaveBeenCalled();
    });

    it('выводит ступень из справочника статусом', async () => {
      await service.update(LEVEL_ID, { status: DirectoryStatus.INACTIVE });

      expect(repository.update).toHaveBeenCalledWith(
        LEVEL_ID,
        expect.objectContaining({ status: DirectoryStatus.INACTIVE }),
      );
    });

    it('404 до всех проверок', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.update(LEVEL_ID, { name: 'Другой' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.findByName).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('Удаление', () => {
    it('удаляет неиспользованную ступень и называет её', async () => {
      const deleted = await service.remove(LEVEL_ID);

      expect(deleted).toEqual({ id: LEVEL_ID, name: 'Senior mentor' });
      expect(repository.delete).toHaveBeenCalledWith(LEVEL_ID);
    });

    it('409, если ступень кому-то проставлена — с числом месяцев', async () => {
      repository.findById.mockResolvedValue(row({ _count: { history: 7 } }));

      await expect(service.remove(LEVEL_ID)).rejects.toMatchObject({
        message: expect.stringContaining('7') as string,
      });
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('отказ предлагает INACTIVE вместо удаления', async () => {
      repository.findById.mockResolvedValue(row({ _count: { history: 1 } }));

      await expect(service.remove(LEVEL_ID)).rejects.toMatchObject({
        message: expect.stringContaining('INACTIVE') as string,
      });
    });

    it('404 на неизвестную ступень', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.remove(LEVEL_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
