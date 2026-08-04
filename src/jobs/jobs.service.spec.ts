import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DirectoryStatus } from '@prisma/client';

import { SortOrder } from '../common';
import { JobQueryDto, JobSortField, MeJobQueryDto } from './dto';
import type { JobRow, JobsRepository } from './jobs.repository';
import { JobsService } from './jobs.service';

const JOB_ID = '11111111-1111-1111-1111-111111111111';

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const row = (overrides: Partial<JobRow> = {}): JobRow => ({
  id: JOB_ID,
  title: 'Frontend-разработчик',
  company: 'ООО «Ромашка»',
  description: null,
  requirements: null,
  contacts: 'hr@romashka.tj',
  deadline: null,
  status: DirectoryStatus.ACTIVE,
  createdAt: new Date('2026-08-04T10:00:00.000Z'),
  updatedAt: new Date('2026-08-04T10:00:00.000Z'),
  ...overrides,
});

// Настоящие экземпляры DTO, а не литералы: `skip`/`take` — вычисляемые геттеры,
// и подделанные значения скрыли бы ошибку в переводе страницы в окно выборки.
const query = (overrides: Partial<JobQueryDto> = {}): JobQueryDto =>
  Object.assign(new JobQueryDto(), overrides);

const meQuery = (overrides: Partial<MeJobQueryDto> = {}): MeJobQueryDto =>
  Object.assign(new MeJobQueryDto(), overrides);

describe('JobsService (ТЗ 5.18)', () => {
  let repository: jest.Mocked<
    Pick<JobsRepository, 'findMany' | 'findById' | 'create' | 'update' | 'delete'>
  >;
  let service: JobsService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findById: jest.fn().mockResolvedValue(row()),
      create: jest.fn().mockImplementation(() => Promise.resolve(row())),
      update: jest.fn().mockImplementation(() => Promise.resolve(row())),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    service = new JobsService(repository as unknown as JobsRepository);
  });

  describe('Список и карточка', () => {
    it('отдаёт все шесть полей ТЗ', async () => {
      repository.findById.mockResolvedValue(
        row({
          description: 'Кабинет клиента на React',
          requirements: 'React, TypeScript',
          deadline: day('2026-11-30'),
        }),
      );

      await expect(service.findOne(JOB_ID)).resolves.toMatchObject({
        title: 'Frontend-разработчик',
        company: 'ООО «Ромашка»',
        description: 'Кабинет клиента на React',
        requirements: 'React, TypeScript',
        contacts: 'hr@romashka.tj',
        deadline: '2026-11-30',
      });
    });

    it('срок отдаётся календарной датой, без времени', async () => {
      repository.findById.mockResolvedValue(row({ deadline: day('2026-11-30') }));

      await expect(service.findOne(JOB_ID)).resolves.toMatchObject({ deadline: '2026-11-30' });
    });

    it('бессрочная вакансия отдаёт `null`, а не пропущенное поле', async () => {
      await expect(service.findOne(JOB_ID)).resolves.toMatchObject({ deadline: null });
    });

    it('«актуальна сегодня» считается по статусу и сроку, а не берётся из БД', async () => {
      repository.findById.mockResolvedValue(row({ deadline: day('2020-01-01') }));

      await expect(service.findOne(JOB_ID)).resolves.toMatchObject({ isOpen: false });
    });

    it('включённая вакансия без срока актуальна', async () => {
      await expect(service.findOne(JOB_ID)).resolves.toMatchObject({ isOpen: true });
    });

    it('`INACTIVE` неактуальна, хотя срок не истёк', async () => {
      repository.findById.mockResolvedValue(
        row({ status: DirectoryStatus.INACTIVE, deadline: day('2030-01-01') }),
      );

      await expect(service.findOne(JOB_ID)).resolves.toMatchObject({ isOpen: false });
    });

    it('передаёт репозиторию окно страницы, фильтры и сортировку', async () => {
      await service.findAll(
        query({
          page: 3,
          limit: 10,
          search: 'react',
          status: DirectoryStatus.INACTIVE,
          open: false,
          sort: JobSortField.Deadline,
          order: SortOrder.Asc,
        }),
      );

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20,
          take: 10,
          search: 'react',
          status: DirectoryStatus.INACTIVE,
          open: false,
          sort: JobSortField.Deadline,
          order: SortOrder.Asc,
        }),
      );
    });

    it('без фильтров сотрудник видит и снятые, и просроченные вакансии: это рабочий список', async () => {
      await service.findAll(query());

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ status: undefined, open: undefined }),
      );
    });

    it('404 на неизвестную вакансию', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findOne(JOB_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('Создание', () => {
    it('заводит вакансию со сроком', async () => {
      await service.create({
        title: 'Frontend-разработчик',
        company: 'ООО «Ромашка»',
        contacts: 'hr@romashka.tj',
        deadline: '2026-11-30',
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Frontend-разработчик',
          company: 'ООО «Ромашка»',
          contacts: 'hr@romashka.tj',
          deadline: day('2026-11-30'),
        }),
      );
    });

    it('без срока кладёт `null`: бессрочный набор — законное состояние', async () => {
      await service.create({ title: 'Тестировщик', company: 'Alif', contacts: 'hr@alif.tj' });

      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ deadline: null }));
    });

    it('пустые описание и требования кладутся как `null`, а не как пустая строка', async () => {
      await service.create({
        title: 'Тестировщик',
        company: 'Alif',
        contacts: 'hr@alif.tj',
        description: '',
        requirements: '',
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ description: null, requirements: null }),
      );
    });

    it('тёзку у другой компании заводит без возражений — уникальности у вакансии нет', async () => {
      await service.create({ title: 'Frontend', company: 'Первая', contacts: 'a@a.tj' });
      await service.create({ title: 'Frontend', company: 'Вторая', contacts: 'b@b.tj' });

      expect(repository.create).toHaveBeenCalledTimes(2);
    });

    it('400 на несуществующую дату (30 февраля) — вакансия не заведена', async () => {
      const error = await service
        .create({ title: 'Т', company: 'К', contacts: 'c', deadline: '2026-02-30' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('срок в прошлом принимается, но вакансия сразу неактуальна', async () => {
      repository.create.mockResolvedValue(row({ deadline: day('2020-01-01') }));

      await expect(
        service.create({ title: 'Т', company: 'К', contacts: 'c', deadline: '2020-01-01' }),
      ).resolves.toMatchObject({ isOpen: false });
    });
  });

  describe('Правка', () => {
    it('не переданные поля не трогает', async () => {
      await service.update(JOB_ID, { title: 'Senior Frontend' });

      expect(repository.update).toHaveBeenCalledWith(
        JOB_ID,
        expect.objectContaining({
          title: 'Senior Frontend',
          company: undefined,
          description: undefined,
          requirements: undefined,
          contacts: undefined,
          deadline: undefined,
          status: undefined,
        }),
      );
    });

    it('пустая строка в сроке снимает его — вакансия становится бессрочной', async () => {
      await service.update(JOB_ID, { deadline: '' });

      expect(repository.update).toHaveBeenCalledWith(
        JOB_ID,
        expect.objectContaining({ deadline: null }),
      );
    });

    it('пустая строка в описании очищает его', async () => {
      await service.update(JOB_ID, { description: '' });

      expect(repository.update).toHaveBeenCalledWith(
        JOB_ID,
        expect.objectContaining({ description: null }),
      );
    });

    it('`INACTIVE` снимает вакансию, не переписывая срок', async () => {
      repository.update.mockResolvedValue(
        row({ status: DirectoryStatus.INACTIVE, deadline: day('2030-01-01') }),
      );

      await expect(
        service.update(JOB_ID, { status: DirectoryStatus.INACTIVE }),
      ).resolves.toMatchObject({
        status: DirectoryStatus.INACTIVE,
        deadline: '2030-01-01',
        isOpen: false,
      });
    });

    it('404 на неизвестную вакансию — правка не выполняется', async () => {
      repository.findById.mockResolvedValue(null);

      const error = await service.update(JOB_ID, { title: 'X' }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('Удаление', () => {
    it('удаляет без единой проверки: на вакансию никто не ссылается', async () => {
      await expect(service.remove(JOB_ID)).resolves.toEqual({
        id: JOB_ID,
        title: 'Frontend-разработчик',
      });
      expect(repository.delete).toHaveBeenCalledWith(JOB_ID);
    });

    it('404 на неизвестную вакансию — удаление не выполняется', async () => {
      repository.findById.mockResolvedValue(null);

      const error = await service.remove(JOB_ID).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect(repository.delete).not.toHaveBeenCalled();
    });
  });

  describe('Кабинет студента (`GET /me/jobs`)', () => {
    it('запрашивает только актуальные — `open: true` задан кодом, а не запросом', async () => {
      await service.findOpen(meQuery());

      expect(repository.findMany).toHaveBeenCalledWith(expect.objectContaining({ open: true }));
    });

    it('передаёт поиск, страницу и сортировку студента', async () => {
      await service.findOpen(
        meQuery({ page: 2, limit: 5, search: 'react', sort: JobSortField.Title }),
      );

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 5,
          take: 5,
          search: 'react',
          sort: JobSortField.Title,
          open: true,
        }),
      );
    });

    it('в форме кабинета нет ни `status`, ни `isOpen`: там все вакансии актуальны', async () => {
      const page = await service.findOpen(meQuery());

      expect(page.items[0]).not.toHaveProperty('status');
      expect(page.items[0]).not.toHaveProperty('isOpen');
      expect(page.items[0]).toMatchObject({
        title: 'Frontend-разработчик',
        company: 'ООО «Ромашка»',
        contacts: 'hr@romashka.tj',
      });
    });

    it('срок студент видит: по нему он понимает, до какого дня успеть', async () => {
      repository.findMany.mockResolvedValue({
        rows: [row({ deadline: day('2026-11-30') })],
        total: 1,
      });

      const page = await service.findOpen(meQuery());

      expect(page.items[0]).toMatchObject({ deadline: '2026-11-30' });
    });
  });
});
