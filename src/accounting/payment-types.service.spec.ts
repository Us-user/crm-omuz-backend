import { ConflictException, NotFoundException } from '@nestjs/common';
import { DirectoryStatus } from '@prisma/client';

import type { AccountingRepository, PaymentTypeRow } from './accounting.repository';
import { PaymentTypesQueryDto, PaymentTypeSortField } from './dto';
import { PaymentTypesService } from './payment-types.service';

const TYPE_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_TYPE_ID = '22222222-2222-2222-2222-222222222222';

const row = (overrides: Partial<PaymentTypeRow> = {}): PaymentTypeRow => ({
  id: TYPE_ID,
  name: 'Alif',
  description: null,
  status: DirectoryStatus.ACTIVE,
  createdAt: new Date('2026-08-01T09:00:00.000Z'),
  _count: { transactions: 0 },
  ...overrides,
});

const query = (overrides: Partial<PaymentTypesQueryDto> = {}): PaymentTypesQueryDto =>
  Object.assign(new PaymentTypesQueryDto(), overrides);

describe('PaymentTypesService', () => {
  let repository: jest.Mocked<
    Pick<
      AccountingRepository,
      | 'findManyTypes'
      | 'findTypeById'
      | 'findTypeByName'
      | 'createType'
      | 'updateType'
      | 'deleteType'
    >
  >;
  let service: PaymentTypesService;

  beforeEach(() => {
    repository = {
      findManyTypes: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findTypeById: jest.fn().mockResolvedValue(row()),
      findTypeByName: jest.fn().mockResolvedValue(null),
      createType: jest.fn().mockResolvedValue(row()),
      updateType: jest.fn().mockResolvedValue(row()),
      deleteType: jest.fn().mockResolvedValue(undefined),
    };

    service = new PaymentTypesService(repository as unknown as AccountingRepository);
  });

  it('отдаёт число платежей рядом со способом', async () => {
    repository.findManyTypes.mockResolvedValue({
      rows: [row({ _count: { transactions: 12 } })],
      total: 1,
    });

    const { items } = await service.findAll(query());

    expect(items[0]).toMatchObject({ name: 'Alif', transactionsCount: 12 });
  });

  it('передаёт окно страницы, фильтр статуса и сортировку', async () => {
    await service.findAll(
      query({
        page: 3,
        limit: 10,
        status: DirectoryStatus.INACTIVE,
        sort: PaymentTypeSortField.CreatedAt,
      }),
    );

    expect(repository.findManyTypes).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 20,
        take: 10,
        status: DirectoryStatus.INACTIVE,
        sort: PaymentTypeSortField.CreatedAt,
      }),
    );
  });

  it('заводит способ оплаты, пустое описание кладёт как `null`', async () => {
    await service.create({ name: 'Наличные', description: '' });

    expect(repository.createType).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Наличные', description: null }),
    );
  });

  it('409 на тёзку без учёта регистра — способ не заводится', async () => {
    repository.findTypeByName.mockResolvedValue({ id: OTHER_TYPE_ID, name: 'Alif' });

    await expect(service.create({ name: 'alif' })).rejects.toBeInstanceOf(ConflictException);
    expect(repository.createType).not.toHaveBeenCalled();
  });

  it('переименование в себя конфликтом не считается', async () => {
    await service.update(TYPE_ID, { name: 'ALIF' });

    expect(repository.findTypeByName).not.toHaveBeenCalled();
    expect(repository.updateType).toHaveBeenCalled();
  });

  it('409 на чужое название при переименовании', async () => {
    repository.findTypeByName.mockResolvedValue({ id: OTHER_TYPE_ID, name: 'Наличные' });

    await expect(service.update(TYPE_ID, { name: 'Наличные' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repository.updateType).not.toHaveBeenCalled();
  });

  it('вывод из работы — обычная правка статуса', async () => {
    await service.update(TYPE_ID, { status: DirectoryStatus.INACTIVE });

    expect(repository.updateType).toHaveBeenCalledWith(
      TYPE_ID,
      expect.objectContaining({ status: DirectoryStatus.INACTIVE }),
    );
  });

  it('удаляет способ, которым не платили', async () => {
    expect(await service.remove(TYPE_ID)).toEqual({ id: TYPE_ID, name: 'Alif' });
    expect(repository.deleteType).toHaveBeenCalledWith(TYPE_ID);
  });

  it('409 на способ с платежами — с числом и предложением INACTIVE', async () => {
    repository.findTypeById.mockResolvedValue(row({ _count: { transactions: 7 } }));

    await expect(service.remove(TYPE_ID)).rejects.toThrow(/платежи \(7\)/);
    expect(repository.deleteType).not.toHaveBeenCalled();
  });

  it('404 на неизвестный способ — до записи', async () => {
    repository.findTypeById.mockResolvedValue(null);

    await expect(service.update(TYPE_ID, { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.updateType).not.toHaveBeenCalled();
  });
});
