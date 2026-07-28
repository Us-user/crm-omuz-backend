import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DirectoryStatus, Prisma } from '@prisma/client';

import { BusinessRuleException, SortOrder } from '../common';
import type { CouponRow, CouponsRepository } from './coupons.repository';
import { CouponsService } from './coupons.service';
import { CouponQueryDto, CouponSortField } from './dto';

const COUPON_ID = '11111111-1111-1111-1111-111111111111';
const COURSE_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_COURSE_ID = '33333333-3333-3333-3333-333333333333';

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const row = (overrides: Partial<CouponRow> = {}): CouponRow => ({
  id: COUPON_ID,
  name: 'OSEN-2026',
  description: null,
  amount: new Prisma.Decimal('250.50'),
  validFrom: null,
  validTo: null,
  status: DirectoryStatus.ACTIVE,
  createdAt: new Date('2026-08-15T10:00:00.000Z'),
  courses: [],
  _count: { leads: 0 },
  ...overrides,
});

// Настоящий экземпляр DTO, а не литерал: `skip`/`take` — вычисляемые геттеры,
// и подделанные значения скрыли бы ошибку в переводе страницы в окно выборки.
const query = (overrides: Partial<CouponQueryDto> = {}): CouponQueryDto =>
  Object.assign(new CouponQueryDto(), overrides);

describe('CouponsService (ТЗ 5.7)', () => {
  let repository: jest.Mocked<
    Pick<
      CouponsRepository,
      'findMany' | 'findById' | 'findByName' | 'findCourses' | 'create' | 'update' | 'delete'
    >
  >;
  let service: CouponsService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findById: jest.fn().mockResolvedValue(row()),
      findByName: jest.fn().mockResolvedValue(null),
      findCourses: jest.fn().mockResolvedValue([{ id: COURSE_ID, title: 'Frontend' }]),
      create: jest.fn().mockImplementation(() => Promise.resolve(row())),
      update: jest.fn().mockImplementation(() => Promise.resolve(row())),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    service = new CouponsService(repository as unknown as CouponsRepository);
  });

  describe('Список и карточка', () => {
    it('переводит `Decimal` в число без потери копеек', async () => {
      await expect(service.findOne(COUPON_ID)).resolves.toMatchObject({ amount: 250.5 });
    });

    it('отдаёт курсы мультивыбора и число обещанных лидов', async () => {
      repository.findById.mockResolvedValue(
        row({
          courses: [{ course: { id: COURSE_ID, title: 'Frontend' } }],
          _count: { leads: 3 },
        }),
      );

      await expect(service.findOne(COUPON_ID)).resolves.toMatchObject({
        courses: [{ id: COURSE_ID, title: 'Frontend' }],
        leadsCount: 3,
      });
    });

    it('пустой набор курсов — это «на все курсы», а не отсутствующее поле', async () => {
      await expect(service.findOne(COUPON_ID)).resolves.toMatchObject({ courses: [] });
    });

    it('даты периода отдаются календарными, без времени', async () => {
      repository.findById.mockResolvedValue(
        row({ validFrom: day('2026-09-01'), validTo: day('2026-11-30') }),
      );

      await expect(service.findOne(COUPON_ID)).resolves.toMatchObject({
        validFrom: '2026-09-01',
        validTo: '2026-11-30',
      });
    });

    it('бессрочный купон отдаёт `null`, а не пропущенные поля', async () => {
      await expect(service.findOne(COUPON_ID)).resolves.toMatchObject({
        validFrom: null,
        validTo: null,
      });
    });

    it('«действует сегодня» считается по статусу и периоду', async () => {
      repository.findById.mockResolvedValue(row({ validTo: day('2020-01-01') }));

      await expect(service.findOne(COUPON_ID)).resolves.toMatchObject({
        isCurrentlyValid: false,
      });
    });

    it('передаёт репозиторию окно страницы, фильтры и сортировку', async () => {
      await service.findAll(
        query({
          page: 3,
          limit: 10,
          search: 'osen',
          status: DirectoryStatus.INACTIVE,
          courseId: COURSE_ID,
          currentlyValid: true,
          sort: CouponSortField.Amount,
          order: SortOrder.Desc,
        }),
      );

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20,
          take: 10,
          search: 'osen',
          status: DirectoryStatus.INACTIVE,
          courseId: COURSE_ID,
          currentlyValid: true,
          sort: CouponSortField.Amount,
          order: SortOrder.Desc,
        }),
      );
    });

    it('404 на неизвестный купон', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findOne(COUPON_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('Создание', () => {
    it('заводит купон с суммой, периодом и курсами', async () => {
      await service.create({
        name: 'OSEN-2026',
        amount: 250.5,
        validFrom: '2026-09-01',
        validTo: '2026-11-30',
        courseIds: [COURSE_ID],
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'OSEN-2026',
          amount: 250.5,
          validFrom: day('2026-09-01'),
          validTo: day('2026-11-30'),
        }),
        [COURSE_ID],
      );
    });

    it('без курсов заводит пустой набор — купон «на все курсы»', async () => {
      await service.create({ name: 'ALL', amount: 100 });

      expect(repository.create).toHaveBeenCalledWith(expect.anything(), []);
      expect(repository.findCourses).not.toHaveBeenCalled();
    });

    it('пустое описание кладётся как `null`, а не как пустая строка', async () => {
      await service.create({ name: 'OSEN', amount: 100, description: '' });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ description: null }),
        [],
      );
    });

    it('нулевая скидка допустима: акция «первое занятие бесплатно» ничего не вычитает', async () => {
      await service.create({ name: 'FREE', amount: 0 });

      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 0 }), []);
    });

    it('409 на тёзку без учёта регистра — купон не создан', async () => {
      repository.findByName.mockResolvedValue({ id: 'other', name: 'OSEN-2026' });

      const error = await service
        .create({ name: 'osen-2026', amount: 100 })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('400 на конец периода раньше начала — купон не создан', async () => {
      const error = await service
        .create({ name: 'OSEN', amount: 100, validFrom: '2026-11-30', validTo: '2026-09-01' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('однодневная акция допустима', async () => {
      await service.create({
        name: 'ONE-DAY',
        amount: 100,
        validFrom: '2026-11-11',
        validTo: '2026-11-11',
      });

      expect(repository.create).toHaveBeenCalled();
    });

    it('400 на несуществующую дату (30 февраля)', async () => {
      await expect(
        service.create({ name: 'OSEN', amount: 100, validFrom: '2026-02-30' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('422 с перечислением только недостающих курсов — купон не создан', async () => {
      const error = await service
        .create({ name: 'OSEN', amount: 100, courseIds: [COURSE_ID, OTHER_COURSE_ID] })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BusinessRuleException);
      expect((error as BusinessRuleException).getResponse()).toMatchObject({
        details: { courseIds: [OTHER_COURSE_ID] },
      });
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('повтор курса в мультивыборе отбрасывается молча', async () => {
      await service.create({ name: 'OSEN', amount: 100, courseIds: [COURSE_ID, COURSE_ID] });

      expect(repository.findCourses).toHaveBeenCalledWith([COURSE_ID]);
      expect(repository.create).toHaveBeenCalledWith(expect.anything(), [COURSE_ID]);
    });
  });

  describe('Правка', () => {
    it('не переданные поля до БД не доходят, а мультивыбор остаётся нетронутым', async () => {
      await service.update(COUPON_ID, { amount: 300 });

      expect(repository.update).toHaveBeenCalledWith(
        COUPON_ID,
        expect.objectContaining({ amount: 300, name: undefined, validFrom: undefined }),
        undefined,
      );
    });

    it('пустой список курсов заменяет набор на «все курсы»', async () => {
      await service.update(COUPON_ID, { courseIds: [] });

      expect(repository.update).toHaveBeenCalledWith(COUPON_ID, expect.anything(), []);
      expect(repository.findCourses).not.toHaveBeenCalled();
    });

    it('переданный список заменяет набор целиком', async () => {
      await service.update(COUPON_ID, { courseIds: [COURSE_ID] });

      expect(repository.update).toHaveBeenCalledWith(COUPON_ID, expect.anything(), [COURSE_ID]);
    });

    it('пустая строка снимает границу периода', async () => {
      repository.findById.mockResolvedValue(row({ validTo: day('2026-11-30') }));

      await service.update(COUPON_ID, { validTo: '' });

      expect(repository.update).toHaveBeenCalledWith(
        COUPON_ID,
        expect.objectContaining({ validTo: null }),
        undefined,
      );
    });

    it('новая граница сверяется с той, что уже лежит в БД', async () => {
      repository.findById.mockResolvedValue(row({ validFrom: day('2026-11-01') }));

      const error = await service
        .update(COUPON_ID, { validTo: '2026-09-01' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('переименование в себя конфликтом не считается', async () => {
      repository.findByName.mockResolvedValue({ id: COUPON_ID, name: 'OSEN-2026' });

      await expect(service.update(COUPON_ID, { name: 'OSEN-2026' })).resolves.toBeDefined();
    });

    it('409 на чужое название', async () => {
      repository.findByName.mockResolvedValue({ id: 'other', name: 'ZIMA' });

      await expect(service.update(COUPON_ID, { name: 'ZIMA' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('без смены названия тёзку не ищем', async () => {
      await service.update(COUPON_ID, { amount: 10 });

      expect(repository.findByName).not.toHaveBeenCalled();
    });

    it('404 до всех проверок', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.update(COUPON_ID, { name: 'ZIMA' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.findByName).not.toHaveBeenCalled();
    });
  });

  describe('Удаление', () => {
    it('удаляет купон, который никому не обещан', async () => {
      await expect(service.remove(COUPON_ID)).resolves.toMatchObject({
        id: COUPON_ID,
        name: 'OSEN-2026',
      });
      expect(repository.delete).toHaveBeenCalledWith(COUPON_ID);
    });

    it('409 с числом лидов и предложением `INACTIVE` — купон остаётся', async () => {
      repository.findById.mockResolvedValue(row({ _count: { leads: 4 } }));

      const error = await service.remove(COUPON_ID).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toContain('(4)');
      expect((error as ConflictException).message).toContain('Inactive');
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('404 на удаление неизвестного купона', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.remove(COUPON_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.delete).not.toHaveBeenCalled();
    });
  });
});
