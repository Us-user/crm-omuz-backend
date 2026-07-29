import { BadRequestException } from '@nestjs/common';

import type { AccountingRepository } from './accounting.repository';
import { OverviewQueryDto } from './dto';
import { OverviewService } from './overview.service';

const GROUP_ID = '11111111-1111-1111-1111-111111111111';
const STUDENT_ID = '22222222-2222-2222-2222-222222222222';
const CATEGORY_ID = '33333333-3333-3333-3333-333333333333';

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const query = (overrides: Partial<OverviewQueryDto> = {}): OverviewQueryDto =>
  Object.assign(new OverviewQueryDto(), overrides);

describe('OverviewService', () => {
  let repository: jest.Mocked<
    Pick<
      AccountingRepository,
      | 'aggregateCharges'
      | 'findIncomeFacts'
      | 'findExpenseFacts'
      | 'findCategoryNodes'
      | 'findGroupChargeFacts'
      | 'findGroupsByIds'
    >
  >;
  let service: OverviewService;

  beforeEach(() => {
    repository = {
      aggregateCharges: jest.fn().mockResolvedValue({ chargedCents: 0, paidCents: 0 }),
      findIncomeFacts: jest.fn().mockResolvedValue([]),
      findExpenseFacts: jest.fn().mockResolvedValue([]),
      findCategoryNodes: jest.fn().mockResolvedValue([]),
      findGroupChargeFacts: jest.fn().mockResolvedValue([]),
      findGroupsByIds: jest.fn().mockResolvedValue([]),
    };

    service = new OverviewService(repository as unknown as AccountingRepository);
  });

  describe('период', () => {
    it('по умолчанию — последние 12 месяцев по текущий', async () => {
      const { period } = await service.find(query());

      expect(period.months).toBe(12);
      expect(period.to).toBe(new Date().toISOString().slice(0, 7));
    });

    it('заданный период отдаётся как есть, вместе с числом месяцев', async () => {
      const { period } = await service.find(query({ from: '2026-01', to: '2026-03' }));

      expect(period).toEqual({ from: '2026-01', to: '2026-03', months: 3 });
    });

    it('один месяц — законный период', async () => {
      const { period } = await service.find(query({ from: '2026-05', to: '2026-05' }));

      expect(period.months).toBe(1);
    });

    it('начисления отбираются отрезком месяцев: `to` — не включающая граница', async () => {
      await service.find(query({ from: '2026-01', to: '2026-03' }));

      expect(repository.aggregateCharges).toHaveBeenCalledWith({
        from: day('2026-01-01'),
        to: day('2026-04-01'),
      });
      expect(repository.findIncomeFacts).toHaveBeenCalledWith(day('2026-01-01'), day('2026-04-01'));
    });

    it('400 на обратный порядок концов — до всех запросов', async () => {
      await expect(service.find(query({ from: '2026-06', to: '2026-01' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.aggregateCharges).not.toHaveBeenCalled();
    });

    it('400 на период длиннее 60 месяцев', async () => {
      await expect(service.find(query({ from: '2020-01', to: '2026-01' }))).rejects.toThrow(
        /максимум 60 месяцев/,
      );
      expect(repository.findIncomeFacts).not.toHaveBeenCalled();
    });

    it('400 на несуществующий месяц', async () => {
      await expect(service.find(query({ to: '2026-13' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('числа обзора', () => {
    it('Total/Paid/Not paid берутся тем же агрегатом, что и `meta.totals` оплат', async () => {
      repository.aggregateCharges.mockResolvedValue({ chargedCents: 960000, paidCents: 672000 });

      const { charges } = await service.find(query({ from: '2026-01', to: '2026-01' }));

      expect(charges).toEqual({ charged: 9600, paid: 6720, debt: 2880 });
    });

    it('Income — принятые деньги по дню платежа, Net = Income − Expense', async () => {
      repository.findIncomeFacts.mockResolvedValue([
        { at: day('2026-01-10'), cents: 500000 },
        { at: day('2026-01-20'), cents: 213000 },
      ]);
      repository.findExpenseFacts.mockResolvedValue([
        { at: day('2026-01-15'), cents: 528000, categoryId: CATEGORY_ID },
      ]);

      const overview = await service.find(query({ from: '2026-01', to: '2026-01' }));

      expect(overview.income).toBe(7130);
      expect(overview.expense).toBe(5280);
      expect(overview.net).toBe(1850);
    });

    it('Net уходит в минус, когда потратили больше, чем получили', async () => {
      repository.findExpenseFacts.mockResolvedValue([
        { at: day('2026-01-15'), cents: 100000, categoryId: CATEGORY_ID },
      ]);

      const { net } = await service.find(query({ from: '2026-01', to: '2026-01' }));

      expect(net).toBe(-1000);
    });

    it('неоплаченный месяц увеличивает долг, но не увеличивает Income', async () => {
      // Главное различие обзора: `charges` — план, `income` — касса.
      repository.aggregateCharges.mockResolvedValue({ chargedCents: 120000, paidCents: 0 });

      const overview = await service.find(query({ from: '2026-01', to: '2026-01' }));

      expect(overview.charges.debt).toBe(1200);
      expect(overview.income).toBe(0);
      expect(overview.net).toBe(0);
    });

    it('копейки не теряются: разность считается в тыйинах', async () => {
      repository.findIncomeFacts.mockResolvedValue([{ at: day('2026-01-10'), cents: 120030 }]);
      repository.findExpenseFacts.mockResolvedValue([
        { at: day('2026-01-11'), cents: 40010, categoryId: CATEGORY_ID },
      ]);

      const { net } = await service.find(query({ from: '2026-01', to: '2026-01' }));

      expect(net).toBe(800.2);
    });
  });

  describe('разрезы', () => {
    it('график покрывает весь период, включая месяцы без операций', async () => {
      repository.findIncomeFacts.mockResolvedValue([{ at: day('2026-03-02'), cents: 100000 }]);

      const { byMonth } = await service.find(query({ from: '2026-01', to: '2026-03' }));

      expect(byMonth.map(({ month }) => month)).toEqual(['2026-01', '2026-02', '2026-03']);
      expect(byMonth.map(({ income }) => income)).toEqual([0, 0, 1000]);
    });

    it('расходы сводятся по корневым категориям', async () => {
      repository.findCategoryNodes.mockResolvedValue([
        { id: 'tax', name: 'Налоги', parent: null },
        { id: CATEGORY_ID, name: 'НДС', parent: { id: 'tax', name: 'Налоги' } },
      ]);
      repository.findExpenseFacts.mockResolvedValue([
        { at: day('2026-01-15'), cents: 300000, categoryId: CATEGORY_ID },
      ]);

      const { byCategory } = await service.find(query({ from: '2026-01', to: '2026-01' }));

      expect(byCategory).toEqual([
        {
          category: { id: 'tax', name: 'Налоги' },
          amount: 3000,
          share: 100,
          children: [{ category: { id: CATEGORY_ID, name: 'НДС' }, amount: 3000 }],
        },
      ]);
    });

    it('«Students payment по группам» подписывается курсом и филиалом', async () => {
      repository.findGroupChargeFacts.mockResolvedValue([
        {
          groupId: GROUP_ID,
          studentId: STUDENT_ID,
          chargedCents: 168000,
          paidCents: 126000,
          debtCents: 42000,
        },
      ]);
      repository.findGroupsByIds.mockResolvedValue([
        {
          id: GROUP_ID,
          name: 'Frontend-1',
          course: { id: 'c-1', name: 'Frontend Basic' },
          branch: { id: 'b-1', name: 'Sadbarg' },
        },
      ]);

      const { byGroup } = await service.find(query({ from: '2026-01', to: '2026-01' }));

      expect(byGroup).toEqual([
        {
          group: { id: GROUP_ID, name: 'Frontend-1' },
          course: { id: 'c-1', name: 'Frontend Basic' },
          branch: { id: 'b-1', name: 'Sadbarg' },
          students: 1,
          charged: 1680,
          paid: 1260,
          debt: 420,
        },
      ]);
    });

    it('группы запрашиваются только те, по которым есть начисления, и по одному разу', async () => {
      repository.findGroupChargeFacts.mockResolvedValue([
        { groupId: GROUP_ID, studentId: 's-1', chargedCents: 100, paidCents: 0, debtCents: 100 },
        { groupId: GROUP_ID, studentId: 's-2', chargedCents: 100, paidCents: 0, debtCents: 100 },
      ]);

      await service.find(query({ from: '2026-01', to: '2026-01' }));

      expect(repository.findGroupsByIds).toHaveBeenCalledWith([GROUP_ID]);
    });

    it('пустой центр отдаёт нули и пустые разрезы, а не падает', async () => {
      const overview = await service.find(query({ from: '2026-01', to: '2026-02' }));

      expect(overview).toMatchObject({
        charges: { charged: 0, paid: 0, debt: 0 },
        income: 0,
        expense: 0,
        net: 0,
        byCategory: [],
        byGroup: [],
      });
      expect(overview.byMonth).toHaveLength(2);
    });
  });
});
