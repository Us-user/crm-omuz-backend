import { ConflictException, NotFoundException } from '@nestjs/common';
import { DirectoryStatus } from '@prisma/client';

import { BusinessRuleException } from '../common';
import type { AccountingRepository, ExpenseCategoryRow } from './accounting.repository';
import { ExpenseCategoriesQueryDto } from './dto';
import { ExpenseCategoriesService } from './expense-categories.service';

const TAX_ID = '11111111-1111-1111-1111-111111111111';
const VAT_ID = '22222222-2222-2222-2222-222222222222';
const OFFICE_ID = '33333333-3333-3333-3333-333333333333';

const row = (overrides: Partial<ExpenseCategoryRow> = {}): ExpenseCategoryRow => ({
  id: TAX_ID,
  name: 'Налоги',
  description: null,
  parent: null,
  status: DirectoryStatus.ACTIVE,
  createdAt: new Date('2026-08-01T09:00:00.000Z'),
  _count: { children: 0, expenses: 0 },
  ...overrides,
});

const query = (overrides: Partial<ExpenseCategoriesQueryDto> = {}): ExpenseCategoriesQueryDto =>
  Object.assign(new ExpenseCategoriesQueryDto(), overrides);

describe('ExpenseCategoriesService', () => {
  let repository: jest.Mocked<
    Pick<
      AccountingRepository,
      | 'findManyCategories'
      | 'findCategoryById'
      | 'findCategoryByName'
      | 'createCategory'
      | 'updateCategory'
      | 'deleteCategory'
    >
  >;
  let service: ExpenseCategoriesService;

  beforeEach(() => {
    repository = {
      findManyCategories: jest.fn().mockResolvedValue([row()]),
      findCategoryById: jest.fn().mockResolvedValue(row()),
      findCategoryByName: jest.fn().mockResolvedValue(null),
      createCategory: jest.fn().mockResolvedValue(row()),
      updateCategory: jest.fn().mockResolvedValue(row()),
      deleteCategory: jest.fn().mockResolvedValue(undefined),
    };

    service = new ExpenseCategoriesService(repository as unknown as AccountingRepository);
  });

  describe('справочник деревом', () => {
    it('собирает подкатегории внутрь родителя', async () => {
      repository.findManyCategories.mockResolvedValue([
        row({ id: TAX_ID, name: 'Налоги', _count: { children: 1, expenses: 0 } }),
        row({ id: VAT_ID, name: 'НДС', parent: { id: TAX_ID, name: 'Налоги' } }),
        row({ id: OFFICE_ID, name: 'Офис' }),
      ]);

      const catalog = await service.findAll(query());

      expect(catalog.total).toBe(3);
      expect(catalog.categories.map(({ name }) => name)).toEqual(['Налоги', 'Офис']);
      expect(catalog.categories[0].children.map(({ name }) => name)).toEqual(['НДС']);
      expect(catalog.categories[1].children).toEqual([]);
    });

    it('подкатегория, чей родитель не прошёл отбор, остаётся видимой строкой', async () => {
      // Иначе она молча пропала бы из справочника — а по ней проведены деньги.
      repository.findManyCategories.mockResolvedValue([
        row({ id: VAT_ID, name: 'НДС', parent: { id: TAX_ID, name: 'Налоги' } }),
      ]);

      const catalog = await service.findAll(query({ status: DirectoryStatus.ACTIVE }));

      expect(catalog.categories.map(({ name }) => name)).toEqual(['НДС']);
    });

    it('передаёт отбор по статусу и поиску как есть', async () => {
      await service.findAll(query({ status: DirectoryStatus.INACTIVE, search: 'налог' }));

      expect(repository.findManyCategories).toHaveBeenCalledWith({
        status: DirectoryStatus.INACTIVE,
        search: 'налог',
      });
    });

    it('в строке — число подкатегорий и расходов', async () => {
      repository.findManyCategories.mockResolvedValue([
        row({ _count: { children: 4, expenses: 17 } }),
      ]);

      const catalog = await service.findAll(query());

      expect(catalog.categories[0]).toMatchObject({ childrenCount: 4, expensesCount: 17 });
    });
  });

  describe('создание', () => {
    it('заводит категорию верхнего уровня, пустое описание кладёт как `null`', async () => {
      await service.create({ name: 'Транспорт', description: '' });

      expect(repository.createCategory).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Транспорт', description: null, parentId: null }),
      );
    });

    it('409 на тёзку без учёта регистра — категория не заводится', async () => {
      repository.findCategoryByName.mockResolvedValue({ id: TAX_ID, name: 'Налоги' });

      await expect(service.create({ name: 'налоги' })).rejects.toBeInstanceOf(ConflictException);
      expect(repository.createCategory).not.toHaveBeenCalled();
    });

    it('вкладывает подкатегорию в категорию верхнего уровня', async () => {
      await service.create({ name: 'НДС', parentId: TAX_ID });

      expect(repository.createCategory).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'НДС', parentId: TAX_ID }),
      );
    });

    it('422 на несуществующего родителя — до записи', async () => {
      repository.findCategoryById.mockResolvedValue(null);

      await expect(service.create({ name: 'НДС', parentId: TAX_ID })).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
      expect(repository.createCategory).not.toHaveBeenCalled();
    });

    it('422 на третий уровень: подкатегорию в подкатегорию вложить нельзя', async () => {
      repository.findCategoryById.mockResolvedValue(
        row({ id: VAT_ID, name: 'НДС', parent: { id: TAX_ID, name: 'Налоги' } }),
      );

      await expect(service.create({ name: 'НДС 5%', parentId: VAT_ID })).rejects.toThrow(
        /двухуровневый/,
      );
      expect(repository.createCategory).not.toHaveBeenCalled();
    });
  });

  describe('правка', () => {
    it('переименование в себя конфликтом не считается', async () => {
      await service.update(TAX_ID, { name: 'НАЛОГИ' });

      expect(repository.findCategoryByName).not.toHaveBeenCalled();
      expect(repository.updateCategory).toHaveBeenCalled();
    });

    it('пустой `parentId` поднимает категорию на верхний уровень', async () => {
      repository.findCategoryById.mockResolvedValue(
        row({ id: VAT_ID, name: 'НДС', parent: { id: TAX_ID, name: 'Налоги' } }),
      );

      await service.update(VAT_ID, { parentId: '' });

      expect(repository.updateCategory).toHaveBeenCalledWith(
        VAT_ID,
        expect.objectContaining({ parentId: null }),
      );
    });

    it('без `parentId` в запросе родитель не трогается', async () => {
      await service.update(TAX_ID, { name: 'Налоги и сборы' });

      expect(repository.updateCategory).toHaveBeenCalledWith(
        TAX_ID,
        expect.objectContaining({ parentId: undefined }),
      );
    });

    it('422 на попытку сделать категорию родителем самой себе', async () => {
      await expect(service.update(TAX_ID, { parentId: TAX_ID })).rejects.toThrow(
        /родителем самой себе/,
      );
      expect(repository.updateCategory).not.toHaveBeenCalled();
    });

    it('422 на вложение категории, у которой есть подкатегории', async () => {
      repository.findCategoryById.mockResolvedValue(row({ _count: { children: 4, expenses: 0 } }));

      await expect(service.update(TAX_ID, { parentId: OFFICE_ID })).rejects.toThrow(
        /подкатегории \(4\)/,
      );
      expect(repository.updateCategory).not.toHaveBeenCalled();
    });

    it('вывод из работы — обычная правка статуса', async () => {
      await service.update(TAX_ID, { status: DirectoryStatus.INACTIVE });

      expect(repository.updateCategory).toHaveBeenCalledWith(
        TAX_ID,
        expect.objectContaining({ status: DirectoryStatus.INACTIVE }),
      );
    });
  });

  describe('удаление', () => {
    it('удаляет неиспользованную категорию', async () => {
      expect(await service.remove(TAX_ID)).toEqual({ id: TAX_ID, name: 'Налоги' });
      expect(repository.deleteCategory).toHaveBeenCalledWith(TAX_ID);
    });

    it('409 на категорию с расходами — с числом и предложением INACTIVE', async () => {
      repository.findCategoryById.mockResolvedValue(row({ _count: { children: 0, expenses: 9 } }));

      await expect(service.remove(TAX_ID)).rejects.toThrow(/расходы \(9\)/);
      expect(repository.deleteCategory).not.toHaveBeenCalled();
    });

    it('409 на категорию с подкатегориями', async () => {
      repository.findCategoryById.mockResolvedValue(row({ _count: { children: 4, expenses: 0 } }));

      await expect(service.remove(TAX_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(repository.deleteCategory).not.toHaveBeenCalled();
    });

    it('404 на неизвестную категорию — до записи', async () => {
      repository.findCategoryById.mockResolvedValue(null);

      await expect(service.remove(TAX_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.deleteCategory).not.toHaveBeenCalled();
    });
  });
});
