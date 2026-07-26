import { ConflictException, NotFoundException } from '@nestjs/common';
import { DirectoryStatus, DurationUnit, Prisma } from '@prisma/client';

import { SortOrder } from '../common';
import type { CourseRow, CoursesRepository } from './courses.repository';
import { CoursesService } from './courses.service';
import { CourseQueryDto, CourseSortField } from './dto';

const COURSE_ID = '11111111-1111-1111-1111-111111111111';

const row = (overrides: Partial<CourseRow> = {}): CourseRow => ({
  id: COURSE_ID,
  title: 'Frontend Basic',
  subtitle: 'HTML, CSS и вёрстка',
  description: null,
  fee: new Prisma.Decimal('1200.50'),
  isLastCourse: false,
  colorPrimary: '#1E88E5',
  colorSecondary: null,
  logoUrl: null,
  durationValue: 1,
  durationUnit: DurationUnit.MONTH,
  status: DirectoryStatus.ACTIVE,
  createdAt: new Date('2026-07-27T10:00:00.000Z'),
  ...overrides,
});

const query = (overrides: Partial<CourseQueryDto> = {}): CourseQueryDto =>
  Object.assign(new CourseQueryDto(), overrides);

describe('CoursesService', () => {
  let repository: jest.Mocked<
    Pick<
      CoursesRepository,
      'findMany' | 'findById' | 'findByTitle' | 'create' | 'update' | 'delete'
    >
  >;
  let service: CoursesService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findById: jest.fn().mockResolvedValue(row()),
      findByTitle: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(() => Promise.resolve(row())),
      update: jest.fn().mockImplementation(() => Promise.resolve(row())),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    service = new CoursesService(repository as unknown as CoursesRepository);
  });

  describe('Список и карточка', () => {
    it('переводит DECIMAL в число без потери копеек', async () => {
      const result = await service.findAll(query());

      expect(result.items[0]?.fee).toBe(1200.5);
      expect(typeof result.items[0]?.fee).toBe('number');
    });

    it('отдаёт длительность парой «число + единица» (ТЗ 5.6)', async () => {
      repository.findById.mockResolvedValue(
        row({ durationValue: 6, durationUnit: DurationUnit.WEEK }),
      );

      await expect(service.findOne(COURSE_ID)).resolves.toMatchObject({
        durationValue: 6,
        durationUnit: DurationUnit.WEEK,
      });
    });

    it('передаёт репозиторию окно страницы и оба доменных фильтра', async () => {
      await service.findAll(
        query({
          page: 2,
          limit: 25,
          status: DirectoryStatus.ACTIVE,
          isLastCourse: true,
          sort: CourseSortField.Fee,
          order: SortOrder.Desc,
        }),
      );

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 25,
          take: 25,
          status: DirectoryStatus.ACTIVE,
          isLastCourse: true,
          sort: CourseSortField.Fee,
          order: SortOrder.Desc,
        }),
      );
    });

    it('404 на неизвестный курс', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findOne(COURSE_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('Создание', () => {
    it('пишет обязательные поля и оставляет необязательные пустыми', async () => {
      await service.create({ title: 'Backend Basic', fee: 1500, durationValue: 1 });

      expect(repository.create).toHaveBeenCalledWith({
        title: 'Backend Basic',
        subtitle: null,
        description: null,
        fee: 1500,
        isLastCourse: undefined,
        colorPrimary: null,
        colorSecondary: null,
        logoUrl: null,
        durationValue: 1,
        durationUnit: undefined,
        status: undefined,
      });
    });

    it('сохраняет флаг «Is last course» — на нём держится автовыпуск (ТЗ 5.11)', async () => {
      await service.create({
        title: 'Backend Advanced',
        fee: 2000,
        durationValue: 2,
        isLastCourse: true,
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ isLastCourse: true }),
      );
    });

    it('409 на тёзку без учёта регистра', async () => {
      repository.findByTitle.mockResolvedValue({ id: 'other', title: 'Frontend Basic' });

      await expect(
        service.create({ title: 'frontend basic', fee: 1200, durationValue: 1 }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('нулевая стоимость допустима — бесплатный курс это не ошибка', async () => {
      await service.create({ title: 'Intro', fee: 0, durationValue: 1 });

      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ fee: 0 }));
    });
  });

  describe('Правка', () => {
    it('не переданные поля остаются undefined — Prisma их пропустит', async () => {
      await service.update(COURSE_ID, { fee: 1400 });

      expect(repository.update).toHaveBeenCalledWith(COURSE_ID, {
        title: undefined,
        subtitle: undefined,
        description: undefined,
        fee: 1400,
        isLastCourse: undefined,
        colorPrimary: undefined,
        colorSecondary: undefined,
        logoUrl: undefined,
        durationValue: undefined,
        durationUnit: undefined,
        status: undefined,
      });
    });

    it('пустая строка очищает подзаголовок, цвет и логотип', async () => {
      await service.update(COURSE_ID, { subtitle: '', colorPrimary: '', logoUrl: '' });

      expect(repository.update).toHaveBeenCalledWith(
        COURSE_ID,
        expect.objectContaining({ subtitle: null, colorPrimary: null, logoUrl: null }),
      );
    });

    it('снятие флага «Is last course» доходит до репозитория как false', async () => {
      await service.update(COURSE_ID, { isLastCourse: false });

      expect(repository.update).toHaveBeenCalledWith(
        COURSE_ID,
        expect.objectContaining({ isLastCourse: false }),
      );
    });

    it('переименование в собственное название не считается конфликтом', async () => {
      repository.findByTitle.mockResolvedValue({ id: COURSE_ID, title: 'Frontend Basic' });

      await expect(service.update(COURSE_ID, { title: 'frontend basic' })).resolves.toMatchObject({
        id: COURSE_ID,
      });
    });

    it('409 на переименование в занятое название', async () => {
      repository.findByTitle.mockResolvedValue({ id: 'other', title: 'Backend Basic' });

      await expect(service.update(COURSE_ID, { title: 'Backend Basic' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('404 на правку неизвестного курса', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.update(COURSE_ID, { fee: 1400 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('Удаление', () => {
    it('удаляет курс и называет удалённое', async () => {
      await expect(service.remove(COURSE_ID)).resolves.toEqual({
        id: COURSE_ID,
        title: 'Frontend Basic',
      });
      expect(repository.delete).toHaveBeenCalledWith(COURSE_ID);
    });

    it('404 на удаление неизвестного курса', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.remove(COURSE_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.delete).not.toHaveBeenCalled();
    });
  });
});
