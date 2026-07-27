import { BadRequestException } from '@nestjs/common';
import { StudentStatus } from '@prisma/client';

import { SortOrder } from '../common';
import { LeftCourseSortField, LeftCoursesQueryDto, LeftCoursesStatsQueryDto } from './dto';
import { MAX_STATS_MONTHS } from './left-courses';
import type {
  LeftCourseFactRow,
  LeftCourseRow,
  LeftCoursesRepository,
} from './left-courses.repository';
import { LeftCoursesService } from './left-courses.service';

const STUDENT_ID = '11111111-1111-1111-1111-111111111111';
const GROUP_ID = '22222222-2222-2222-2222-222222222222';
const COURSE_ID = '33333333-3333-3333-3333-333333333333';
const BRANCH_ID = '44444444-4444-4444-4444-444444444444';
const MENTOR_ID = '55555555-5555-5555-5555-555555555555';

const groupOf = (): LeftCourseRow['group'] => ({
  id: GROUP_ID,
  name: 'Frontend-1',
  course: { id: COURSE_ID, title: 'Frontend Basic' },
  branch: { id: BRANCH_ID, name: 'Sadbarg' },
});

const row = (overrides: Partial<LeftCourseRow> = {}): LeftCourseRow => ({
  groupId: GROUP_ID,
  studentId: STUDENT_ID,
  statusReason: 'Переехал в другой город',
  statusChangedAt: new Date('2026-06-14T08:30:00.000Z'),
  enrolledAt: new Date('2026-02-01T00:00:00.000Z'),
  student: {
    id: STUDENT_ID,
    firstName: 'Нигина',
    lastName: 'Каримова',
    phone: '+992901234567',
    photoUrl: null,
    status: StudentStatus.NO_ACTIVE,
  },
  group: groupOf(),
  mentorAtLeave: { id: MENTOR_ID, firstName: 'Фаррух', lastName: 'Раҳимов' },
  ...overrides,
});

const factRow = (leftAt: string | null, group = groupOf()): LeftCourseFactRow => ({
  statusChangedAt: leftAt === null ? null : new Date(leftAt),
  group,
});

const query = (overrides: Partial<LeftCoursesQueryDto> = {}): LeftCoursesQueryDto =>
  Object.assign(new LeftCoursesQueryDto(), overrides);

const statsQuery = (overrides: Partial<LeftCoursesStatsQueryDto> = {}): LeftCoursesStatsQueryDto =>
  Object.assign(new LeftCoursesStatsQueryDto(), overrides);

describe('LeftCoursesService', () => {
  let repository: jest.Mocked<Pick<LeftCoursesRepository, 'findMany' | 'findFacts'>>;
  let service: LeftCoursesService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findFacts: jest.fn().mockResolvedValue([]),
    };

    service = new LeftCoursesService(repository as unknown as LeftCoursesRepository);
  });

  describe('Список покинувших (ТЗ 5.12)', () => {
    it('отдаёт студента, группу, курс, филиал, ментора, причину и дату', async () => {
      const result = await service.findAll(query());

      expect(result.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(result.items[0]).toEqual({
        student: {
          id: STUDENT_ID,
          firstName: 'Нигина',
          lastName: 'Каримова',
          phone: '+992901234567',
          photoUrl: null,
          status: StudentStatus.NO_ACTIVE,
        },
        group: { id: GROUP_ID, name: 'Frontend-1' },
        course: { id: COURSE_ID, name: 'Frontend Basic' },
        branch: { id: BRANCH_ID, name: 'Sadbarg' },
        mentor: { id: MENTOR_ID, firstName: 'Фаррух', lastName: 'Раҳимов' },
        reason: 'Переехал в другой город',
        leftAt: '2026-06-14T08:30:00.000Z',
        enrolledAt: '2026-02-01T00:00:00.000Z',
      });
    });

    // Снимок ментора появился только с этой сессии: у строк, закрытых раньше,
    // его нет — и подставлять сегодняшний состав менторов витрина не должна.
    it('уход без снимка ментора отдаётся с null, а не с текущим составом', async () => {
      repository.findMany.mockResolvedValue({
        rows: [row({ mentorAtLeave: null, statusReason: null, statusChangedAt: null })],
        total: 1,
      });

      expect(await service.findAll(query())).toMatchObject({
        items: [{ mentor: null, reason: null, leftAt: null }],
      });
    });

    it('строка есть и у того, кто продолжает учиться на другом курсе', async () => {
      repository.findMany.mockResolvedValue({
        rows: [row({ student: { ...row().student, status: StudentStatus.ACTIVE } })],
        total: 1,
      });

      expect(await service.findAll(query())).toMatchObject({
        items: [{ student: { status: StudentStatus.ACTIVE } }],
      });
    });

    it('передаёт окно страницы, разрезы, поиск и сортировку', async () => {
      await service.findAll(
        query({
          page: 3,
          limit: 50,
          groupId: GROUP_ID,
          courseId: COURSE_ID,
          branchId: BRANCH_ID,
          search: 'переезд',
          sort: LeftCourseSortField.Name,
          order: SortOrder.Asc,
        }),
      );

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          groupId: GROUP_ID,
          courseId: COURSE_ID,
          branchId: BRANCH_ID,
          search: 'переезд',
          sort: LeftCourseSortField.Name,
          order: SortOrder.Asc,
          skip: 100,
          take: 50,
        }),
      );
    });

    it('по умолчанию свежие уходы сверху', async () => {
      await service.findAll(query());

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ sort: LeftCourseSortField.LeftAt, order: SortOrder.Desc }),
      );
    });

    it('без периода границы до БД не доходят', async () => {
      await service.findAll(query());

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ from: undefined, to: undefined }),
      );
    });

    // Границы периода включающие, поэтому правая уходит в запрос первым числом
    // **следующего** месяца: иначе июньские уходы отсекались бы по первому июня.
    it('переводит период в отрезок с невключающей правой границей', async () => {
      await service.findAll(query({ from: '2026-04', to: '2026-06' }));

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          from: new Date('2026-04-01T00:00:00.000Z'),
          to: new Date('2026-07-01T00:00:00.000Z'),
        }),
      );
    });

    it('открытая граница остаётся открытой', async () => {
      await service.findAll(query({ from: '2026-04' }));

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ from: new Date('2026-04-01T00:00:00.000Z'), to: undefined }),
      );
    });

    it('400 на негодный месяц в фильтре — до запроса', async () => {
      await expect(service.findAll(query({ from: '2026-13' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.findMany).not.toHaveBeenCalled();
    });

    it('400 на начало периода позже конца', async () => {
      await expect(
        service.findAll(query({ from: '2026-06', to: '2026-04' })),
      ).rejects.toMatchObject({ response: { details: { from: '2026-06', to: '2026-04' } } });
      expect(repository.findMany).not.toHaveBeenCalled();
    });
  });

  describe('Статистика оттока (ТЗ 5.12: помесячный график)', () => {
    it('считает ряд по месяцам и разрезы', async () => {
      repository.findFacts.mockResolvedValue([
        factRow('2026-04-03T10:00:00.000Z'),
        factRow('2026-06-10T10:00:00.000Z'),
        factRow('2026-06-28T10:00:00.000Z'),
      ]);

      const result = await service.stats(statsQuery({ from: '2026-04', to: '2026-06' }));

      expect(result).toMatchObject({
        from: '2026-04',
        to: '2026-06',
        total: 3,
        byMonth: [
          { month: '2026-04', count: 1 },
          { month: '2026-05', count: 0 },
          { month: '2026-06', count: 2 },
        ],
        byGroup: [{ group: { id: GROUP_ID, name: 'Frontend-1' }, count: 3 }],
        byCourse: [{ ref: { id: COURSE_ID, name: 'Frontend Basic' }, count: 3 }],
        byBranch: [{ ref: { id: BRANCH_ID, name: 'Sadbarg' }, count: 3 }],
      });
    });

    it('пустой период отдаёт нули по каждому месяцу, а не пустой ряд', async () => {
      const result = await service.stats(statsQuery({ from: '2026-05', to: '2026-06' }));

      expect(result.total).toBe(0);
      expect(result.byMonth).toEqual([
        { month: '2026-05', count: 0 },
        { month: '2026-06', count: 0 },
      ]);
      expect(result.byGroup).toEqual([]);
    });

    // Уход без даты положить не в какой месяц: он не должен ни попасть
    // в чужой столбец, ни завысить общее число.
    it('уход без даты в статистику не попадает', async () => {
      repository.findFacts.mockResolvedValue([factRow('2026-06-10T10:00:00.000Z'), factRow(null)]);

      const result = await service.stats(statsQuery({ from: '2026-06', to: '2026-06' }));

      expect(result.total).toBe(1);
      expect(result.byMonth).toEqual([{ month: '2026-06', count: 1 }]);
    });

    it('передаёт отрезок и разрезы в выборку', async () => {
      await service.stats(
        statsQuery({ from: '2026-04', to: '2026-06', groupId: GROUP_ID, branchId: BRANCH_ID }),
      );

      expect(repository.findFacts).toHaveBeenCalledWith({
        groupId: GROUP_ID,
        courseId: undefined,
        branchId: BRANCH_ID,
        from: new Date('2026-04-01T00:00:00.000Z'),
        to: new Date('2026-07-01T00:00:00.000Z'),
      });
    });

    it('без параметров берёт последний год, считая текущий месяц', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-15T12:00:00.000Z'));

      try {
        const result = await service.stats(statsQuery());

        expect(result).toMatchObject({ from: '2025-08', to: '2026-07' });
        expect(result.byMonth).toHaveLength(12);
      } finally {
        jest.useRealTimers();
      }
    });

    it('заданное начало не двигает конец периода', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-15T12:00:00.000Z'));

      try {
        expect(await service.stats(statsQuery({ from: '2026-05' }))).toMatchObject({
          from: '2026-05',
          to: '2026-07',
        });
      } finally {
        jest.useRealTimers();
      }
    });

    it('заданный конец достраивает начало на год назад', async () => {
      expect(await service.stats(statsQuery({ to: '2026-03' }))).toMatchObject({
        from: '2025-04',
        to: '2026-03',
      });
    });

    it('400 на период длиннее потолка — до запроса', async () => {
      await expect(
        service.stats(statsQuery({ from: '2000-01', to: '2026-06' })),
      ).rejects.toMatchObject({ response: { details: { months: expect.any(Number) } } });
      expect(repository.findFacts).not.toHaveBeenCalled();
    });

    it('период ровно в потолок проходит', async () => {
      const result = await service.stats(statsQuery({ from: '2021-07', to: '2026-06' }));

      expect(result.byMonth).toHaveLength(MAX_STATS_MONTHS);
    });

    it('400 на начало периода позже конца', async () => {
      await expect(
        service.stats(statsQuery({ from: '2026-06', to: '2026-04' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.findFacts).not.toHaveBeenCalled();
    });

    it('400 на негодный месяц — до запроса', async () => {
      await expect(service.stats(statsQuery({ to: '2026-00' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.findFacts).not.toHaveBeenCalled();
    });
  });
});
