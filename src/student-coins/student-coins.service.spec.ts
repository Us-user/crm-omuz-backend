import { NotFoundException } from '@nestjs/common';
import { CoinSource } from '@prisma/client';

import { SortOrder } from '../common';
import { CoinQueryDto, CoinSortField } from './dto';
import type { CoinTransactionRow, StudentCoinsRepository } from './student-coins.repository';
import { StudentCoinsService } from './student-coins.service';

const STUDENT_ID = '11111111-1111-1111-1111-111111111111';
const TRANSACTION_ID = '22222222-2222-2222-2222-222222222222';
const AUTHOR_ID = '33333333-3333-3333-3333-333333333333';
const ACTOR_ACCOUNT_ID = '44444444-4444-4444-4444-444444444444';
const WEEK_ID = '55555555-5555-5555-5555-555555555555';
const GROUP_ID = '66666666-6666-6666-6666-666666666666';

const row = (overrides: Partial<CoinTransactionRow> = {}): CoinTransactionRow => ({
  id: TRANSACTION_ID,
  studentId: STUDENT_ID,
  amount: 3,
  reason: 'Помог однокурсникам с проектом',
  source: CoinSource.MANUAL,
  createdAt: new Date('2026-09-21T09:00:00.000Z'),
  author: { id: AUTHOR_ID, firstName: 'Фаррух', lastName: 'Раҳимов' },
  week: null,
  ...overrides,
});

// Настоящий экземпляр DTO, а не литерал: `skip`/`take` — вычисляемые геттеры.
const query = (overrides: Partial<CoinQueryDto> = {}): CoinQueryDto =>
  Object.assign(new CoinQueryDto(), overrides);

describe('StudentCoinsService', () => {
  let repository: jest.Mocked<
    Pick<
      StudentCoinsRepository,
      'findMany' | 'findStudent' | 'findEmployeeByAccount' | 'findBalance' | 'award'
    >
  >;
  let service: StudentCoinsService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findStudent: jest
        .fn()
        .mockResolvedValue({ id: STUDENT_ID, firstName: 'Нигина', lastName: 'Каримова' }),
      findEmployeeByAccount: jest.fn().mockResolvedValue({ id: AUTHOR_ID }),
      findBalance: jest.fn().mockResolvedValue(14),
      award: jest
        .fn()
        .mockImplementation(({ amount }: { amount: number }) =>
          Promise.resolve({ row: row({ amount }), balance: 14 + amount }),
        ),
    };

    service = new StudentCoinsService(repository as unknown as StudentCoinsRepository);
  });

  describe('Баланс и история', () => {
    it('отдаёт строку истории с автором и временем', async () => {
      const result = await service.findAll(STUDENT_ID, query());

      expect(result.items[0]).toMatchObject({
        id: TRANSACTION_ID,
        amount: 3,
        source: CoinSource.MANUAL,
        author: { lastName: 'Раҳимов' },
        createdAt: '2026-09-21T09:00:00.000Z',
      });
    });

    it('кладёт баланс в meta рядом с пагинацией', async () => {
      // ТЗ 5.9: «Баланс и история». Баланс один на все страницы, и отдельный
      // запрос ради одного числа был бы лишним обращением.
      const result = await service.findAll(STUDENT_ID, query());

      expect(result.meta).toMatchObject({ total: 1, page: 1, limit: 20, balance: 14 });
    });

    it('по умолчанию свежие сверху', async () => {
      await service.findAll(STUDENT_ID, query());

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ order: SortOrder.Desc, sort: CoinSortField.CreatedAt }),
      );
    });

    it('передаёт окно страницы и фильтр источника', async () => {
      await service.findAll(
        STUDENT_ID,
        query({ page: 3, limit: 5, source: CoinSource.WEEK_RESULT }),
      );

      expect(repository.findMany).toHaveBeenCalledWith({
        studentId: STUDENT_ID,
        source: CoinSource.WEEK_RESULT,
        sort: CoinSortField.CreatedAt,
        order: SortOrder.Desc,
        skip: 10,
        take: 5,
      });
    });

    it('автоначисление отдаётся вместе с неделей', async () => {
      repository.findMany.mockResolvedValue({
        rows: [
          row({
            source: CoinSource.WEEK_RESULT,
            author: null,
            week: { id: WEEK_ID, groupId: GROUP_ID, weekNumber: 3 },
            reason: 'Итог недели 3: 104 балла',
          }),
        ],
        total: 1,
      });

      const result = await service.findAll(STUDENT_ID, query());

      expect(result.items[0]).toMatchObject({
        source: CoinSource.WEEK_RESULT,
        author: null,
        week: { weekNumber: 3 },
      });
    });

    it('404 на неизвестного студента — до запроса истории', async () => {
      repository.findStudent.mockResolvedValue(null);

      await expect(service.findAll(STUDENT_ID, query())).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findMany).not.toHaveBeenCalled();
    });
  });

  describe('Ручное начисление', () => {
    it('начисляет с причиной и отдаёт новый баланс', async () => {
      const result = await service.award(
        STUDENT_ID,
        { amount: 3, reason: 'Помог однокурсникам' },
        ACTOR_ACCOUNT_ID,
      );

      expect(result).toMatchObject({ balance: 17, transaction: { amount: 3 } });
      expect(repository.award).toHaveBeenCalledWith({
        studentId: STUDENT_ID,
        amount: 3,
        reason: 'Помог однокурсникам',
        source: CoinSource.MANUAL,
        authorId: AUTHOR_ID,
      });
    });

    it('автор берётся из токена, а не из тела', async () => {
      await service.award(STUDENT_ID, { amount: 1, reason: 'Активность' }, ACTOR_ACCOUNT_ID);

      expect(repository.findEmployeeByAccount).toHaveBeenCalledWith(ACTOR_ACCOUNT_ID);
    });

    it('аккаунт без профиля сотрудника начисляет без подписи', async () => {
      repository.findEmployeeByAccount.mockResolvedValue(null);

      await service.award(STUDENT_ID, { amount: 1, reason: 'Активность' }, ACTOR_ACCOUNT_ID);

      expect(repository.award).toHaveBeenCalledWith(expect.objectContaining({ authorId: null }));
    });

    it('404 на неизвестного студента — до записи', async () => {
      repository.findStudent.mockResolvedValue(null);

      await expect(
        service.award(STUDENT_ID, { amount: 1, reason: 'Активность' }, ACTOR_ACCOUNT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.award).not.toHaveBeenCalled();
    });
  });
});
