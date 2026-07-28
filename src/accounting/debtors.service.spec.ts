import { BadRequestException } from '@nestjs/common';
import { StudentStatus } from '@prisma/client';

import type { AccountingRepository, StudentProfile } from './accounting.repository';
import { DebtorsService } from './debtors.service';
import { DebtorsQueryDto } from './dto';

const STUDENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STUDENT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const GROUP_ID = '33333333-3333-3333-3333-333333333333';
const BRANCH_ID = '55555555-5555-5555-5555-555555555555';

const profile = (id: string, lastName: string): StudentProfile => ({
  id,
  firstName: 'Нилуфар',
  lastName,
  phone: '+992901234567',
  status: StudentStatus.ACTIVE,
  branch: { id: BRANCH_ID, name: 'Sadbarg' },
});

const query = (overrides: Partial<DebtorsQueryDto> = {}): DebtorsQueryDto =>
  Object.assign(new DebtorsQueryDto(), overrides);

describe('DebtorsService', () => {
  let repository: jest.Mocked<
    Pick<
      AccountingRepository,
      'findDebts' | 'findChargeTotals' | 'findPrepaid' | 'findStudentsByIds'
    >
  >;
  let service: DebtorsService;

  beforeEach(() => {
    repository = {
      findDebts: jest.fn().mockResolvedValue([
        {
          studentId: STUDENT_A,
          debtCents: 240000,
          unpaidMonths: 2,
          oldestUnpaidMonth: new Date('2026-08-01T00:00:00.000Z'),
        },
      ]),
      findChargeTotals: jest
        .fn()
        .mockResolvedValue([{ studentId: STUDENT_A, chargedCents: 360000, paidCents: 120000 }]),
      findPrepaid: jest.fn().mockResolvedValue([]),
      findStudentsByIds: jest.fn().mockResolvedValue([profile(STUDENT_A, 'Каримова')]),
    };

    service = new DebtorsService(repository as unknown as AccountingRepository);
  });

  it('собирает строку должника в сомони', async () => {
    const { items } = await service.findAll(query());

    expect(items[0]).toMatchObject({
      student: { id: STUDENT_A, lastName: 'Каримова', status: StudentStatus.ACTIVE },
      branch: { id: BRANCH_ID, name: 'Sadbarg' },
      charged: 3600,
      paid: 1200,
      debt: 2400,
      prepaid: 0,
      unpaidMonths: 2,
      oldestUnpaidMonth: '2026-08',
    });
  });

  it('предоплата стоит отдельной колонкой и долг не гасит', async () => {
    repository.findPrepaid.mockResolvedValue([{ studentId: STUDENT_A, cents: 300000 }]);

    const { items } = await service.findAll(query());

    expect(items[0]).toMatchObject({ debt: 2400, prepaid: 3000 });
  });

  it('итоги по всему набору уходят в `meta`', async () => {
    repository.findDebts.mockResolvedValue([
      {
        studentId: STUDENT_A,
        debtCents: 240000,
        unpaidMonths: 2,
        oldestUnpaidMonth: new Date('2026-08-01T00:00:00.000Z'),
      },
      {
        studentId: STUDENT_B,
        debtCents: 60000,
        unpaidMonths: 1,
        oldestUnpaidMonth: new Date('2026-09-01T00:00:00.000Z'),
      },
    ]);
    repository.findChargeTotals.mockResolvedValue([
      { studentId: STUDENT_A, chargedCents: 360000, paidCents: 120000 },
      { studentId: STUDENT_B, chargedCents: 120000, paidCents: 60000 },
    ]);
    repository.findStudentsByIds.mockResolvedValue([
      profile(STUDENT_A, 'Каримова'),
      profile(STUDENT_B, 'Раҳимов'),
    ]);

    const { meta } = await service.findAll(query());

    expect(meta).toMatchObject({
      total: 2,
      totals: { students: 2, debt: 3000, charged: 4800, paid: 1800 },
    });
  });

  it('страница нарезается из отсортированного по долгу списка', async () => {
    repository.findDebts.mockResolvedValue([
      {
        studentId: STUDENT_A,
        debtCents: 50000,
        unpaidMonths: 1,
        oldestUnpaidMonth: new Date('2026-09-01T00:00:00.000Z'),
      },
      {
        studentId: STUDENT_B,
        debtCents: 300000,
        unpaidMonths: 3,
        oldestUnpaidMonth: new Date('2026-07-01T00:00:00.000Z'),
      },
    ]);
    repository.findChargeTotals.mockResolvedValue([]);
    repository.findStudentsByIds.mockResolvedValue([profile(STUDENT_B, 'Раҳимов')]);

    const { items, meta } = await service.findAll(query({ limit: 1 }));

    // Профили запрашиваются только для страницы — второго запроса на строку нет.
    expect(repository.findStudentsByIds).toHaveBeenCalledWith([STUDENT_B]);
    expect(items).toHaveLength(1);
    expect(meta.total).toBe(2);
  });

  it('рассчитавшийся студент в витрину не попадает', async () => {
    repository.findDebts.mockResolvedValue([]);
    repository.findChargeTotals.mockResolvedValue([]);
    repository.findStudentsByIds.mockResolvedValue([]);

    const { items, meta } = await service.findAll(query());

    expect(items).toEqual([]);
    expect(meta).toMatchObject({ total: 0, totals: { students: 0, debt: 0 } });
  });

  it('передаёт доменные фильтры и период отрезком месяцев', async () => {
    await service.findAll(query({ groupId: GROUP_ID, from: '2026-08', to: '2026-09' }));

    expect(repository.findDebts).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: GROUP_ID,
        from: new Date('2026-08-01T00:00:00.000Z'),
        to: new Date('2026-10-01T00:00:00.000Z'),
      }),
    );
  });

  it('400 на негодный месяц — до запросов', async () => {
    await expect(service.findAll(query({ from: '2026-13' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repository.findDebts).not.toHaveBeenCalled();
  });

  it('пустой набор должников профили не запрашивает', async () => {
    repository.findDebts.mockResolvedValue([]);

    await service.findAll(query());

    expect(repository.findStudentsByIds).toHaveBeenCalledWith([]);
  });
});
