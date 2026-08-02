import { BadRequestException } from '@nestjs/common';
import {
  AttendanceMark,
  GraduateEmployment,
  GroupStatus,
  LeadType,
  StudentStatus,
} from '@prisma/client';

import { MAX_DASHBOARD_MONTHS } from './dashboard';
import type {
  AttendanceFactRow,
  DashboardLeftCourseRow,
  DashboardRepository,
  GraduateFactRow,
  LeadFactRow,
} from './dashboard.repository';
import { DashboardService } from './dashboard.service';
import type {
  DashboardIncomeQueryDto,
  DashboardPeriodQueryDto,
  DashboardSummaryQueryDto,
} from './dto';

const GROUP_ID = '22222222-2222-2222-2222-222222222222';
const COURSE_ID = '33333333-3333-3333-3333-333333333333';
const BRANCH_ID = '44444444-4444-4444-4444-444444444444';

const periodQuery = (overrides: DashboardPeriodQueryDto = {}): DashboardPeriodQueryDto => overrides;

const summaryQuery = (overrides: DashboardSummaryQueryDto = {}): DashboardSummaryQueryDto =>
  overrides;

const incomeQuery = (overrides: DashboardIncomeQueryDto = {}): DashboardIncomeQueryDto => overrides;

const attendanceFact = (at: string, mark: AttendanceMark, count: number): AttendanceFactRow => ({
  at: new Date(at),
  mark,
  count,
});

const leadRow = (at: string, overrides: Partial<LeadFactRow> = {}): LeadFactRow => ({
  createdAt: new Date(at),
  type: LeadType.LEAD,
  convertedStudentId: null,
  utmSource: null,
  course: null,
  ...overrides,
});

const graduateRow = (
  at: string,
  employment: GraduateEmployment | null = null,
): GraduateFactRow => ({ graduatedAt: new Date(at), employment });

const leftRow = (at: string | null): DashboardLeftCourseRow => ({
  statusChangedAt: at === null ? null : new Date(at),
  group: {
    id: GROUP_ID,
    name: 'Frontend-1',
    course: { id: COURSE_ID, title: 'Frontend Basic' },
    branch: { id: BRANCH_ID, name: 'Sadbarg' },
  },
});

type RepositoryMock = jest.Mocked<
  Pick<
    DashboardRepository,
    | 'countLessonsOn'
    | 'aggregateAttendanceOn'
    | 'countStudentsByStatus'
    | 'countGroupsByStatus'
    | 'countActiveMentors'
    | 'findAttendanceFacts'
    | 'findLeadFacts'
    | 'sumIncome'
    | 'sumExpense'
    | 'sumSalary'
    | 'findGraduateFacts'
    | 'findLeftCourseFacts'
  >
>;

describe('DashboardService', () => {
  let repository: RepositoryMock;
  let service: DashboardService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-03T09:15:00.000Z'));

    repository = {
      countLessonsOn: jest.fn().mockResolvedValue(0),
      aggregateAttendanceOn: jest.fn().mockResolvedValue([]),
      countStudentsByStatus: jest.fn().mockResolvedValue([]),
      countGroupsByStatus: jest.fn().mockResolvedValue([]),
      countActiveMentors: jest.fn().mockResolvedValue(0),
      findAttendanceFacts: jest.fn().mockResolvedValue([]),
      findLeadFacts: jest.fn().mockResolvedValue([]),
      sumIncome: jest.fn().mockResolvedValue(0),
      sumExpense: jest.fn().mockResolvedValue(0),
      sumSalary: jest.fn().mockResolvedValue(0),
      findGraduateFacts: jest.fn().mockResolvedValue([]),
      findLeftCourseFacts: jest.fn().mockResolvedValue([]),
    };

    service = new DashboardService(repository as unknown as DashboardRepository);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Сводка (ТЗ 5.2)', () => {
    it('собирает посещаемость дня и счётчики', async () => {
      repository.countLessonsOn.mockResolvedValue(3);
      repository.aggregateAttendanceOn.mockResolvedValue([
        { mark: AttendanceMark.PRESENT, count: 18 },
        { mark: AttendanceMark.LATE, count: 2 },
        { mark: AttendanceMark.ABSENT, count: 5 },
      ]);
      repository.countStudentsByStatus.mockResolvedValue([
        { status: StudentStatus.ACTIVE, count: 40 },
        { status: StudentStatus.FINISHED, count: 12 },
        { status: StudentStatus.BLOCK, count: 1 },
      ]);
      repository.countGroupsByStatus.mockResolvedValue([
        { status: GroupStatus.ACTIVE, count: 6 },
        { status: GroupStatus.RECRUITING, count: 2 },
      ]);
      repository.countActiveMentors.mockResolvedValue(4);

      const summary = await service.summary(summaryQuery({ date: '2026-08-03' }));

      expect(summary).toEqual({
        date: '2026-08-03',
        attendance: { lessons: 3, present: 18, late: 2, absent: 5, marked: 25, attendanceRate: 80 },
        students: { active: 40, noActive: 0, finished: 12, blocked: 1, total: 53 },
        mentors: { active: 4 },
        groups: { recruiting: 2, active: 6, finished: 0, cancelled: 0, total: 8 },
      });
    });

    it('без даты берётся сегодняшний день (UTC), полночью', async () => {
      const summary = await service.summary(summaryQuery());

      expect(summary.date).toBe('2026-08-03');
      expect(repository.countLessonsOn).toHaveBeenCalledWith(new Date('2026-08-03T00:00:00.000Z'));
      expect(repository.aggregateAttendanceOn).toHaveBeenCalledWith(
        new Date('2026-08-03T00:00:00.000Z'),
      );
    });

    it('статус, которого нет в агрегате, — это ноль, а не пропавшее поле', async () => {
      const summary = await service.summary(summaryQuery());

      expect(summary.students).toEqual({
        active: 0,
        noActive: 0,
        finished: 0,
        blocked: 0,
        total: 0,
      });
      expect(summary.groups.total).toBe(0);
    });

    it('день без отметок отдаёт null вместо доли, а не ноль', async () => {
      const summary = await service.summary(summaryQuery({ date: '2026-08-03' }));

      expect(summary.attendance.attendanceRate).toBeNull();
    });

    it('400 на несуществующую дату — до запросов в БД', async () => {
      await expect(service.summary(summaryQuery({ date: '2026-02-30' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(repository.countLessonsOn).not.toHaveBeenCalled();
    });
  });

  describe('График посещаемости (ТЗ 5.2)', () => {
    it('без периода показывается год, заканчивая текущим месяцем', async () => {
      const result = await service.attendance(periodQuery());

      expect(result.period).toEqual({ from: '2025-09', to: '2026-08', months: 12 });
      expect(result.byMonth).toHaveLength(12);
    });

    it('передаёт в выборку отрезок с невключающей правой границей', async () => {
      await service.attendance(periodQuery({ from: '2026-04', to: '2026-06' }));

      expect(repository.findAttendanceFacts).toHaveBeenCalledWith(
        new Date('2026-04-01T00:00:00.000Z'),
        new Date('2026-07-01T00:00:00.000Z'),
      );
    });

    it('итог считается по всему периоду тем же правилом, что и столбцы', async () => {
      repository.findAttendanceFacts.mockResolvedValue([
        attendanceFact('2026-04-06T00:00:00.000Z', AttendanceMark.PRESENT, 10),
        attendanceFact('2026-06-02T00:00:00.000Z', AttendanceMark.ABSENT, 10),
      ]);

      const result = await service.attendance(periodQuery({ from: '2026-04', to: '2026-06' }));

      expect(result.totals).toEqual({
        present: 10,
        late: 0,
        absent: 10,
        marked: 20,
        attendanceRate: 50,
      });
      expect(result.byMonth.map(({ month }) => month)).toEqual(['2026-04', '2026-05', '2026-06']);
      expect(result.byMonth[1]?.attendanceRate).toBeNull();
    });

    it('400 на перевёрнутый период — до запроса', async () => {
      await expect(
        service.attendance(periodQuery({ from: '2026-06', to: '2026-04' })),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(repository.findAttendanceFacts).not.toHaveBeenCalled();
    });

    it('400 на период длиннее потолка, а ровно в потолок проходит', async () => {
      await expect(
        service.attendance(periodQuery({ from: '2021-07', to: '2026-08' })),
      ).rejects.toBeInstanceOf(BadRequestException);

      const result = await service.attendance(periodQuery({ from: '2021-09', to: '2026-08' }));

      expect(result.period.months).toBe(MAX_DASHBOARD_MONTHS);
    });

    it('400 на несуществующий месяц', async () => {
      await expect(service.attendance(periodQuery({ to: '2026-13' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('Статистика лидов (ТЗ 5.2)', () => {
    it('сводит воронку по когортам месяцев', async () => {
      repository.findLeadFacts.mockResolvedValue([
        leadRow('2026-04-03T10:00:00.000Z', {
          type: LeadType.CLIENT,
          convertedStudentId: 'student-1',
          utmSource: 'instagram',
          course: { id: COURSE_ID, title: 'Frontend Basic' },
        }),
        leadRow('2026-04-08T10:00:00.000Z', { utmSource: 'instagram' }),
        leadRow('2026-06-01T10:00:00.000Z', { type: LeadType.CLIENT }),
      ]);

      const result = await service.leads(periodQuery({ from: '2026-04', to: '2026-06' }));

      expect(result.totals).toEqual({
        total: 3,
        leads: 1,
        clients: 2,
        converted: 1,
        clientRate: 66.67,
        conversionRate: 33.33,
      });
      expect(result.byMonth).toEqual([
        { month: '2026-04', total: 2, clients: 1, converted: 1 },
        { month: '2026-05', total: 0, clients: 0, converted: 0 },
        { month: '2026-06', total: 1, clients: 1, converted: 0 },
      ]);
    });

    it('«переведён» выводится из ссылки на профиль, а не из отдельного флага', async () => {
      repository.findLeadFacts.mockResolvedValue([
        leadRow('2026-04-03T10:00:00.000Z', { convertedStudentId: 'student-1' }),
        leadRow('2026-04-04T10:00:00.000Z'),
      ]);

      const result = await service.leads(periodQuery({ from: '2026-04', to: '2026-04' }));

      expect(result.totals.converted).toBe(1);
    });

    it('курс отдаётся названием, разрез идёт по UTM-метке', async () => {
      repository.findLeadFacts.mockResolvedValue([
        leadRow('2026-04-03T10:00:00.000Z', {
          utmSource: 'google',
          course: { id: COURSE_ID, title: 'Frontend Basic' },
        }),
      ]);

      const result = await service.leads(periodQuery({ from: '2026-04', to: '2026-04' }));

      expect(result.byCourse).toEqual([
        { course: { id: COURSE_ID, name: 'Frontend Basic' }, count: 1 },
      ]);
      expect(result.byUtmSource).toEqual([{ source: 'google', count: 1 }]);
    });

    it('передаёт отрезок обращений с невключающей правой границей', async () => {
      await service.leads(periodQuery({ from: '2026-04', to: '2026-06' }));

      expect(repository.findLeadFacts).toHaveBeenCalledWith(
        new Date('2026-04-01T00:00:00.000Z'),
        new Date('2026-07-01T00:00:00.000Z'),
      );
    });

    it('пустой период отдаёт нули и null-доли', async () => {
      const result = await service.leads(periodQuery({ from: '2026-04', to: '2026-04' }));

      expect(result.totals.total).toBe(0);
      expect(result.totals.conversionRate).toBeNull();
      expect(result.byUtmSource).toEqual([]);
    });
  });

  describe('Доход за месяц со сравнением (ТЗ 5.2)', () => {
    it('считает четыре числа месяца и предыдущего месяца', async () => {
      repository.sumIncome.mockImplementation((from: Date) =>
        Promise.resolve(from.getUTCMonth() === 7 ? 120_000 : 100_000),
      );
      repository.sumExpense.mockImplementation((from: Date) =>
        Promise.resolve(from.getUTCMonth() === 7 ? 30_000 : 20_000),
      );
      repository.sumSalary.mockImplementation((from: Date) =>
        Promise.resolve(from.getUTCMonth() === 7 ? 50_000 : 50_000),
      );

      const result = await service.income(incomeQuery({ month: '2026-08' }));

      expect(result.month).toBe('2026-08');
      expect(result.previousMonth).toBe('2026-07');
      expect(result.income).toEqual({
        current: 1200,
        previous: 1000,
        change: 200,
        changePercent: 20,
      });
      // Net = Income − Expense − Salary, тем же правилом, что в обзоре (0030).
      expect(result.net).toEqual({
        current: 400,
        previous: 300,
        change: 100,
        changePercent: 33.33,
      });
    });

    it('без месяца берётся текущий', async () => {
      const result = await service.income(incomeQuery());

      expect(result.month).toBe('2026-08');
      expect(result.previousMonth).toBe('2026-07');
    });

    it('окна месяца и предыдущего месяца стыкуются встык', async () => {
      await service.income(incomeQuery({ month: '2026-01' }));

      expect(repository.sumIncome).toHaveBeenCalledWith(
        new Date('2026-01-01T00:00:00.000Z'),
        new Date('2026-02-01T00:00:00.000Z'),
      );
      // Декабрь предыдущего года: сдвиг месяца переносит год сам.
      expect(repository.sumIncome).toHaveBeenCalledWith(
        new Date('2025-12-01T00:00:00.000Z'),
        new Date('2026-01-01T00:00:00.000Z'),
      );
    });

    it('пустой предыдущий месяц не даёт процента роста', async () => {
      repository.sumIncome.mockImplementation((from: Date) =>
        Promise.resolve(from.getUTCMonth() === 7 ? 50_000 : 0),
      );

      const result = await service.income(incomeQuery({ month: '2026-08' }));

      expect(result.income.changePercent).toBeNull();
      expect(result.income.change).toBe(500);
    });

    it('отрицательный итог — законный ответ', async () => {
      repository.sumIncome.mockResolvedValue(10_000);
      repository.sumExpense.mockResolvedValue(40_000);

      const result = await service.income(incomeQuery({ month: '2026-08' }));

      expect(result.net.current).toBe(-300);
    });

    it('400 на несуществующий месяц — до запросов', async () => {
      await expect(service.income(incomeQuery({ month: '2026-13' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(repository.sumIncome).not.toHaveBeenCalled();
    });
  });

  describe('Выпускники (ТЗ 5.2)', () => {
    it('счётчики и доля трудоустройства считаются по одному набору строк', async () => {
      repository.findGraduateFacts.mockResolvedValue([
        graduateRow('2026-04-30T00:00:00.000Z', GraduateEmployment.WORK),
        graduateRow('2026-04-30T00:00:00.000Z', GraduateEmployment.FREELANCER),
        graduateRow('2026-06-30T00:00:00.000Z', GraduateEmployment.OPEN_TO_WORK),
        graduateRow('2026-06-30T00:00:00.000Z'),
      ]);

      const result = await service.graduates(periodQuery({ from: '2026-04', to: '2026-06' }));

      expect(result.total).toBe(4);
      expect(result.employed).toBe(2);
      // Знаменатель — выясненные (3), а не все четверо.
      expect(result.employmentRate).toBe(66.67);
      expect(result.employment.unknown).toBe(1);
      expect(result.byMonth).toEqual([
        { month: '2026-04', count: 2 },
        { month: '2026-05', count: 0 },
        { month: '2026-06', count: 2 },
      ]);
    });

    it('статус, которого нет ни у кого, остаётся в ответе нулём', async () => {
      repository.findGraduateFacts.mockResolvedValue([
        graduateRow('2026-04-30T00:00:00.000Z', GraduateEmployment.WORK),
      ]);

      const result = await service.graduates(periodQuery({ from: '2026-04', to: '2026-04' }));

      expect(result.employment[GraduateEmployment.ENTREPRENEUR]).toBe(0);
    });

    it('без выпусков доли нет — это null, а не ноль', async () => {
      const result = await service.graduates(periodQuery({ from: '2026-04', to: '2026-04' }));

      expect(result.total).toBe(0);
      expect(result.employmentRate).toBeNull();
    });

    it('передаёт отрезок выпусков с невключающей правой границей', async () => {
      await service.graduates(periodQuery({ from: '2026-04', to: '2026-06' }));

      expect(repository.findGraduateFacts).toHaveBeenCalledWith(
        new Date('2026-04-01T00:00:00.000Z'),
        new Date('2026-07-01T00:00:00.000Z'),
      );
    });
  });

  describe('Отток (ТЗ 5.2)', () => {
    it('сводит уходы в ряд и разрез по курсам', async () => {
      repository.findLeftCourseFacts.mockResolvedValue([
        leftRow('2026-04-15T00:00:00.000Z'),
        leftRow('2026-06-02T00:00:00.000Z'),
      ]);

      const result = await service.leftCourses(periodQuery({ from: '2026-04', to: '2026-06' }));

      expect(result.total).toBe(2);
      expect(result.byMonth).toEqual([
        { month: '2026-04', count: 1 },
        { month: '2026-05', count: 0 },
        { month: '2026-06', count: 1 },
      ]);
      expect(result.byCourse).toEqual([
        { ref: { id: COURSE_ID, name: 'Frontend Basic' }, count: 2 },
      ]);
    });

    it('уход без даты в статистику не идёт', async () => {
      repository.findLeftCourseFacts.mockResolvedValue([leftRow(null)]);

      const result = await service.leftCourses(periodQuery({ from: '2026-04', to: '2026-06' }));

      expect(result.total).toBe(0);
    });

    it('передаёт отрезок уходов с невключающей правой границей', async () => {
      await service.leftCourses(periodQuery({ from: '2026-04', to: '2026-06' }));

      expect(repository.findLeftCourseFacts).toHaveBeenCalledWith(
        new Date('2026-04-01T00:00:00.000Z'),
        new Date('2026-07-01T00:00:00.000Z'),
      );
    });

    it('400 на слишком длинный период', async () => {
      await expect(
        service.leftCourses(periodQuery({ from: '2020-01', to: '2026-08' })),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(repository.findLeftCourseFacts).not.toHaveBeenCalled();
    });
  });
});
