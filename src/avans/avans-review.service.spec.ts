import { ConflictException, NotFoundException } from '@nestjs/common';
import { AvansStatus, EmployeeStatus, Prisma } from '@prisma/client';

import { BusinessRuleException } from '../common';
import { AvansReviewService } from './avans-review.service';
import type { AvansRepository, AvansReviewRow } from './avans.repository';
import { AvansReviewQueryDto } from './dto';

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';
const EMPLOYEE_ID = '22222222-2222-2222-2222-222222222222';
const ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';
const REVIEWER_ID = '44444444-4444-4444-4444-444444444444';

const row = (overrides: Partial<AvansReviewRow> = {}): AvansReviewRow => ({
  id: REQUEST_ID,
  employeeId: EMPLOYEE_ID,
  employee: {
    id: EMPLOYEE_ID,
    firstName: 'Фаррух',
    lastName: 'Раҳимов',
    status: EmployeeStatus.ACTIVE,
  },
  amount: new Prisma.Decimal('500.00'),
  reason: 'Оплата аренды жилья',
  month: new Date('2026-09-01T00:00:00.000Z'),
  status: AvansStatus.PENDING,
  reviewedAt: null,
  reviewComment: null,
  createdAt: new Date('2026-09-01T09:00:00.000Z'),
  createdBy: null,
  reviewedBy: null,
  ...overrides,
});

const reviewed = (status: AvansStatus): AvansReviewRow =>
  row({
    status,
    reviewedAt: new Date('2026-09-05T08:30:00.000Z'),
    reviewComment: 'Одобрено в полном объёме',
    reviewedBy: { id: REVIEWER_ID, firstName: 'Аниса', lastName: 'Р.' },
  });

const query = (overrides: Partial<AvansReviewQueryDto> = {}): AvansReviewQueryDto =>
  Object.assign(new AvansReviewQueryDto(), overrides);

describe('AvansReviewService', () => {
  let repository: jest.Mocked<
    Pick<
      AvansRepository,
      'findManyForReview' | 'findByIdForReview' | 'review' | 'findPending' | 'findEmployeeByAccount'
    >
  >;
  let service: AvansReviewService;

  beforeEach(() => {
    repository = {
      findManyForReview: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findByIdForReview: jest.fn().mockResolvedValue(row()),
      review: jest.fn().mockResolvedValue(reviewed(AvansStatus.APPROVED)),
      findPending: jest.fn().mockResolvedValue(null),
      findEmployeeByAccount: jest.fn().mockResolvedValue({ id: REVIEWER_ID }),
    };

    service = new AvansReviewService(repository as unknown as AvansRepository);
  });

  describe('очередь', () => {
    it('отдаёт сотрудника в строке — адрес про него ничего не говорит', async () => {
      const page = await service.findAll(query());

      expect(page.items[0]).toMatchObject({
        id: REQUEST_ID,
        employee: { id: EMPLOYEE_ID, lastName: 'Раҳимов', status: EmployeeStatus.ACTIVE },
        amount: 500,
        month: '2026-09',
        status: AvansStatus.PENDING,
        review: null,
      });
    });

    it('итог рассмотрения отдаётся объектом, а не тремя полями', async () => {
      repository.findManyForReview.mockResolvedValue({
        rows: [reviewed(AvansStatus.APPROVED)],
        total: 1,
      });

      const page = await service.findAll(query());

      expect(page.items[0].review).toEqual({
        reviewedBy: { id: REVIEWER_ID, firstName: 'Аниса', lastName: 'Р.' },
        reviewedAt: '2026-09-05T08:30:00.000Z',
        comment: 'Одобрено в полном объёме',
      });
    });

    it('передаёт окно страницы, фильтры, период и поиск', async () => {
      await service.findAll(
        query({
          page: 2,
          limit: 5,
          status: AvansStatus.PENDING,
          employeeId: EMPLOYEE_ID,
          from: '2026-01',
          to: '2026-12',
          search: 'Раҳимов',
        }),
      );

      expect(repository.findManyForReview).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 5,
          take: 5,
          status: AvansStatus.PENDING,
          employeeId: EMPLOYEE_ID,
          from: new Date('2026-01-01T00:00:00.000Z'),
          to: new Date('2026-12-01T00:00:00.000Z'),
          search: 'Раҳимов',
        }),
      );
    });

    it('без периода границы до БД не доходят', async () => {
      await service.findAll(query());

      expect(repository.findManyForReview).toHaveBeenCalledWith(
        expect.objectContaining({ from: undefined, to: undefined }),
      );
    });

    it('404 на неизвестную заявку в карточке', async () => {
      repository.findByIdForReview.mockResolvedValue(null);

      await expect(service.findOne(REQUEST_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('одобрение', () => {
    it('ставит `APPROVED`, подписывает рассмотревшего из токена и пишет комментарий', async () => {
      await service.approve(REQUEST_ID, { comment: 'Одобрено' }, ACCOUNT_ID);

      expect(repository.review).toHaveBeenCalledWith(REQUEST_ID, {
        status: AvansStatus.APPROVED,
        reviewedById: REVIEWER_ID,
        comment: 'Одобрено',
      });
    });

    it('комментарий необязателен: согласие с заявкой объяснять нечем', async () => {
      await service.approve(REQUEST_ID, {}, ACCOUNT_ID);

      expect(repository.review).toHaveBeenCalledWith(
        REQUEST_ID,
        expect.objectContaining({ comment: null }),
      );
    });

    it('аккаунт без профиля сотрудника не оставляет подписи', async () => {
      repository.findEmployeeByAccount.mockResolvedValue(null);

      await service.approve(REQUEST_ID, {}, ACCOUNT_ID);

      expect(repository.review).toHaveBeenCalledWith(
        REQUEST_ID,
        expect.objectContaining({ reviewedById: null }),
      );
    });

    it('422 на одобрение выведенному из штата — решение не пишется', async () => {
      // Одобренная заявка становится `Prepaid` месяца (ТЗ 5.16), то есть
      // выплатой тому, кого в штате нет.
      repository.findByIdForReview.mockResolvedValue(
        row({
          employee: {
            id: EMPLOYEE_ID,
            firstName: 'Фаррух',
            lastName: 'Раҳимов',
            status: EmployeeStatus.INACTIVE,
          },
        }),
      );

      await expect(service.approve(REQUEST_ID, {}, ACCOUNT_ID)).rejects.toThrow(
        BusinessRuleException,
      );
      expect(repository.review).not.toHaveBeenCalled();
    });

    it.each([AvansStatus.APPROVED, AvansStatus.DENIED])(
      '409 на повторное рассмотрение (%s)',
      async (status) => {
        repository.findByIdForReview.mockResolvedValue(reviewed(status));

        await expect(service.approve(REQUEST_ID, {}, ACCOUNT_ID)).rejects.toThrow(
          ConflictException,
        );
        expect(repository.review).not.toHaveBeenCalled();
      },
    );

    it('404 до записи решения', async () => {
      repository.findByIdForReview.mockResolvedValue(null);

      await expect(service.approve(REQUEST_ID, {}, ACCOUNT_ID)).rejects.toThrow(NotFoundException);
      expect(repository.review).not.toHaveBeenCalled();
    });
  });

  describe('отказ', () => {
    it('ставит `DENIED` с обязательной причиной', async () => {
      repository.review.mockResolvedValue(reviewed(AvansStatus.DENIED));

      const result = await service.deny(
        REQUEST_ID,
        { comment: 'Превышает половину оклада' },
        ACCOUNT_ID,
      );

      expect(repository.review).toHaveBeenCalledWith(REQUEST_ID, {
        status: AvansStatus.DENIED,
        reviewedById: REVIEWER_ID,
        comment: 'Превышает половину оклада',
      });
      expect(result.status).toBe(AvansStatus.DENIED);
    });

    it('выведенному из штата отказать можно — запрет только на одобрение', async () => {
      repository.findByIdForReview.mockResolvedValue(
        row({
          employee: {
            id: EMPLOYEE_ID,
            firstName: 'Фаррух',
            lastName: 'Раҳимов',
            status: EmployeeStatus.INACTIVE,
          },
        }),
      );
      repository.review.mockResolvedValue(reviewed(AvansStatus.DENIED));

      await service.deny(REQUEST_ID, { comment: 'Уволен' }, ACCOUNT_ID);

      expect(repository.review).toHaveBeenCalled();
    });

    it('409 на повторное рассмотрение', async () => {
      repository.findByIdForReview.mockResolvedValue(reviewed(AvansStatus.APPROVED));

      await expect(
        service.deny(REQUEST_ID, { comment: 'Не согласны' }, ACCOUNT_ID),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('снятие рассмотрения', () => {
    it('возвращает заявку в `PENDING` и гасит колонки решения', async () => {
      repository.findByIdForReview.mockResolvedValue(reviewed(AvansStatus.APPROVED));
      repository.review.mockResolvedValue(row());

      const result = await service.reopen(REQUEST_ID, { reason: 'Одобрено по ошибке' }, ACCOUNT_ID);

      expect(repository.review).toHaveBeenCalledWith(REQUEST_ID, {
        status: AvansStatus.PENDING,
        reviewedById: REVIEWER_ID,
        comment: null,
      });
      expect(result.review).toBeNull();
    });

    it('422 на снятие с нерассмотренной заявки — снимать нечего', async () => {
      await expect(service.reopen(REQUEST_ID, { reason: 'Ошибка' }, ACCOUNT_ID)).rejects.toThrow(
        BusinessRuleException,
      );
      expect(repository.review).not.toHaveBeenCalled();
    });

    it('409, если у сотрудника уже есть другая нерассмотренная заявка', async () => {
      // Иначе снятие решения по старой заявке при живой новой оставило бы
      // у человека две `PENDING` — состояние, которое подача не допускает (0022).
      repository.findByIdForReview.mockResolvedValue(reviewed(AvansStatus.DENIED));
      repository.findPending.mockResolvedValue(
        row({ amount: new Prisma.Decimal('900.00'), month: new Date('2026-10-01T00:00:00.000Z') }),
      );

      await expect(
        service.reopen(REQUEST_ID, { reason: 'Отказ ошибочный' }, ACCOUNT_ID),
      ).rejects.toThrow(ConflictException);
      expect(repository.review).not.toHaveBeenCalled();
    });

    it('нерассмотренную ищет у того же сотрудника', async () => {
      repository.findByIdForReview.mockResolvedValue(reviewed(AvansStatus.APPROVED));
      repository.review.mockResolvedValue(row());

      await service.reopen(REQUEST_ID, { reason: 'Ошибка' }, ACCOUNT_ID);

      expect(repository.findPending).toHaveBeenCalledWith(EMPLOYEE_ID);
    });

    it('404 на неизвестную заявку', async () => {
      repository.findByIdForReview.mockResolvedValue(null);

      await expect(service.reopen(REQUEST_ID, { reason: 'Ошибка' }, ACCOUNT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
