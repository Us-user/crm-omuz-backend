import { NotFoundException } from '@nestjs/common';
import { AttendanceMark, GroupStudentStatus } from '@prisma/client';

import { ActivityCategory } from './performance';
import type {
  PerformanceRepository,
  StudentMembershipRow,
  StudentWeekResultRow,
} from './performance.repository';
import { PerformanceService } from './performance.service';

const STUDENT_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_STUDENT_ID = '99999999-9999-9999-9999-999999999999';
const GROUP_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_GROUP_ID = '33333333-3333-3333-3333-333333333333';
const COURSE_ID = '44444444-4444-4444-4444-444444444444';
const BRANCH_ID = '55555555-5555-5555-5555-555555555555';

const student = { id: STUDENT_ID, firstName: 'Нигина', lastName: 'Каримова' };

let weekSeq = 0;

const weekResult = (
  sum: number,
  overrides: { groupId?: string; weekNumber?: number; bonus?: number; exam?: number } = {},
): StudentWeekResultRow => {
  weekSeq += 1;

  return {
    sum,
    bonus: overrides.bonus ?? 0,
    exam: overrides.exam ?? 0,
    week: {
      id: `week-${String(weekSeq)}`,
      weekNumber: overrides.weekNumber ?? weekSeq,
      startDate: new Date(`2026-09-0${String((weekSeq % 7) + 1)}T00:00:00.000Z`),
      submittedAt: new Date('2026-09-14T09:00:00.000Z'),
      groupId: overrides.groupId ?? GROUP_ID,
    },
  };
};

const membership = (
  overrides: { groupId?: string; name?: string; status?: GroupStudentStatus } = {},
): StudentMembershipRow => ({
  status: overrides.status ?? GroupStudentStatus.ACTIVE,
  group: {
    id: overrides.groupId ?? GROUP_ID,
    name: overrides.name ?? 'Frontend-1',
    course: { id: COURSE_ID, title: 'Frontend Basic' },
    branch: { id: BRANCH_ID, name: 'Sadbarg' },
  },
});

describe('PerformanceService', () => {
  let repository: jest.Mocked<
    Pick<
      PerformanceRepository,
      | 'findStudent'
      | 'findFinalizedResults'
      | 'findMemberships'
      | 'aggregateAttendance'
      | 'findRankedAverages'
    >
  >;
  let service: PerformanceService;

  beforeEach(() => {
    weekSeq = 0;
    repository = {
      findStudent: jest.fn().mockResolvedValue(student),
      findFinalizedResults: jest.fn().mockResolvedValue([]),
      findMemberships: jest.fn().mockResolvedValue([]),
      aggregateAttendance: jest.fn().mockResolvedValue([]),
      findRankedAverages: jest.fn().mockResolvedValue([]),
    };

    service = new PerformanceService(repository as unknown as PerformanceRepository);
  });

  describe('Общий балл (ТЗ 5.8)', () => {
    it('среднее Sum по финализированным неделям', async () => {
      repository.findFinalizedResults.mockResolvedValue([
        weekResult(100),
        weekResult(90),
        weekResult(80),
      ]);

      const result = await service.findStudentPerformance(STUDENT_ID);

      expect(result.averageScore).toBe(90);
      expect(result.weeksCount).toBe(3);
    });

    it('округляет до двух знаков', async () => {
      repository.findFinalizedResults.mockResolvedValue([weekResult(100), weekResult(99)]);

      await expect(service.findStudentPerformance(STUDENT_ID)).resolves.toMatchObject({
        averageScore: 99.5,
      });
    });

    it('без закрытых недель балла нет, а не ноль', async () => {
      // Ноль записал бы студента в Black list за то, что группа
      // ещё не дошла до первой финализации.
      const result = await service.findStudentPerformance(STUDENT_ID);

      expect(result).toMatchObject({
        averageScore: null,
        category: null,
        categoryTitle: null,
        passing: false,
        weeksCount: 0,
      });
    });

    it('категория выводится из общего балла (ТЗ 5.5)', async () => {
      repository.findFinalizedResults.mockResolvedValue([weekResult(96), weekResult(98)]);

      await expect(service.findStudentPerformance(STUDENT_ID)).resolves.toMatchObject({
        averageScore: 97,
        category: ActivityCategory.ChatGpt,
        categoryTitle: 'ChatGPT',
        passing: true,
      });
    });

    it('балл ниже 45 даёт Black list и не считается успевающим', async () => {
      repository.findFinalizedResults.mockResolvedValue([weekResult(40)]);

      await expect(service.findStudentPerformance(STUDENT_ID)).resolves.toMatchObject({
        category: ActivityCategory.BlackList,
        passing: false,
      });
    });

    it('404 до всех остальных запросов', async () => {
      repository.findStudent.mockResolvedValue(null);

      await expect(service.findStudentPerformance(STUDENT_ID)).rejects.toThrow(NotFoundException);
      expect(repository.findFinalizedResults).not.toHaveBeenCalled();
      expect(repository.findRankedAverages).not.toHaveBeenCalled();
    });
  });

  describe('Рейтинг и корона (ТЗ 5.3, 5.13)', () => {
    it('место — «сколько выше, плюс один»', async () => {
      repository.findFinalizedResults.mockResolvedValue([weekResult(80)]);
      repository.findRankedAverages.mockResolvedValue([
        { studentId: 'a', average: 95 },
        { studentId: 'b', average: 90 },
        { studentId: STUDENT_ID, average: 80 },
        { studentId: 'c', average: 70 },
      ]);

      await expect(service.findStudentPerformance(STUDENT_ID)).resolves.toMatchObject({
        rank: { position: 3, totalRanked: 4, isTopStudent: false, ranked: true },
      });
    });

    it('первый в рейтинге получает корону', async () => {
      repository.findFinalizedResults.mockResolvedValue([weekResult(95)]);
      repository.findRankedAverages.mockResolvedValue([
        { studentId: STUDENT_ID, average: 95 },
        { studentId: 'b', average: 90 },
      ]);

      await expect(service.findStudentPerformance(STUDENT_ID)).resolves.toMatchObject({
        rank: { position: 1, isTopStudent: true, ranked: true },
      });
    });

    it('при равенстве баллов корона у обоих, и место одно и то же', async () => {
      // Придуманное правило разрыва ничьей поставило бы одного из двух
      // одинаково успевающих ниже без всякого основания.
      repository.findFinalizedResults.mockResolvedValue([weekResult(95)]);
      repository.findRankedAverages.mockResolvedValue([
        { studentId: STUDENT_ID, average: 95 },
        { studentId: 'b', average: 95 },
      ]);

      await expect(service.findStudentPerformance(STUDENT_ID)).resolves.toMatchObject({
        rank: { position: 1, totalRanked: 2, isTopStudent: true },
      });
    });

    it('не учащийся сейчас в рейтинг не входит, но балл у него есть', async () => {
      // Решение сессии 0019: иначе корона навсегда осталась бы у выпускника.
      repository.findFinalizedResults.mockResolvedValue([weekResult(100)]);
      repository.findRankedAverages.mockResolvedValue([
        { studentId: OTHER_STUDENT_ID, average: 50 },
      ]);

      const result = await service.findStudentPerformance(STUDENT_ID);

      expect(result.averageScore).toBe(100);
      expect(result.rank).toStrictEqual({
        position: null,
        totalRanked: 1,
        isTopStudent: false,
        ranked: false,
      });
    });

    it('пустой рейтинг никого не коронует', async () => {
      await expect(service.findStudentPerformance(STUDENT_ID)).resolves.toMatchObject({
        rank: { position: null, totalRanked: 0, isTopStudent: false, ranked: false },
      });
    });

    it('место сравнивается по неокруглённому баллу', async () => {
      // 87.334 и 87.335 показали бы одинаковые 87.33 — округление
      // до сравнения объявило бы первыми обоих.
      repository.findFinalizedResults.mockResolvedValue([weekResult(87)]);
      repository.findRankedAverages.mockResolvedValue([
        { studentId: 'a', average: 87.335 },
        { studentId: STUDENT_ID, average: 87.334 },
      ]);

      await expect(service.findStudentPerformance(STUDENT_ID)).resolves.toMatchObject({
        rank: { position: 2, isTopStudent: false },
      });
    });
  });

  describe('Посещаемость (ТЗ 5.2, 5.5)', () => {
    it('считает отметки и долю приходов', async () => {
      repository.aggregateAttendance.mockResolvedValue([
        { attendance: AttendanceMark.PRESENT, count: 8 },
        { attendance: AttendanceMark.LATE, count: 2 },
        { attendance: AttendanceMark.ABSENT, count: 2 },
      ]);

      await expect(service.findStudentPerformance(STUDENT_ID)).resolves.toMatchObject({
        attendance: { present: 8, late: 2, absent: 2, marked: 12, attendanceRate: 83.33 },
      });
    });

    it('опоздание считается приходом — тем же правилом, что и балл (ТЗ 5.8)', async () => {
      repository.aggregateAttendance.mockResolvedValue([
        { attendance: AttendanceMark.LATE, count: 4 },
      ]);

      await expect(service.findStudentPerformance(STUDENT_ID)).resolves.toMatchObject({
        attendance: { late: 4, marked: 4, attendanceRate: 100 },
      });
    });

    it('без отметок доли нет, а не ноль процентов', async () => {
      await expect(service.findStudentPerformance(STUDENT_ID)).resolves.toMatchObject({
        attendance: { present: 0, late: 0, absent: 0, marked: 0, attendanceRate: null },
      });
    });

    it('одни пропуски дают нулевую долю', async () => {
      repository.aggregateAttendance.mockResolvedValue([
        { attendance: AttendanceMark.ABSENT, count: 3 },
      ]);

      await expect(service.findStudentPerformance(STUDENT_ID)).resolves.toMatchObject({
        attendance: { absent: 3, attendanceRate: 0 },
      });
    });
  });

  describe('Разрез по группам', () => {
    it('балл считается внутри каждой группы отдельно', async () => {
      repository.findMemberships.mockResolvedValue([
        membership(),
        membership({ groupId: OTHER_GROUP_ID, name: 'Python-1' }),
      ]);
      repository.findFinalizedResults.mockResolvedValue([
        weekResult(100, { groupId: GROUP_ID }),
        weekResult(90, { groupId: GROUP_ID }),
        weekResult(50, { groupId: OTHER_GROUP_ID }),
      ]);

      const result = await service.findStudentPerformance(STUDENT_ID);

      expect(result.groups).toStrictEqual([
        expect.objectContaining({
          groupId: GROUP_ID,
          groupName: 'Frontend-1',
          averageScore: 95,
          category: ActivityCategory.ChatGpt,
          weeksCount: 2,
        }),
        expect.objectContaining({
          groupId: OTHER_GROUP_ID,
          groupName: 'Python-1',
          averageScore: 50,
          category: ActivityCategory.Kettle,
          weeksCount: 1,
        }),
      ]);
      // Общий балл усредняет всё сразу — и он не равен ни одному из групповых.
      expect(result.averageScore).toBe(80);
    });

    it('группа без закрытых недель остаётся в списке с баллом null', async () => {
      // Иначе «мои группы» и «моя успеваемость» показывали бы разный состав,
      // и пропажу группы читали бы как ошибку.
      repository.findMemberships.mockResolvedValue([membership()]);

      await expect(service.findStudentPerformance(STUDENT_ID)).resolves.toMatchObject({
        groups: [expect.objectContaining({ averageScore: null, category: null, weeksCount: 0 })],
      });
    });

    it('закрытое членство из истории не пропадает', async () => {
      repository.findMemberships.mockResolvedValue([
        membership({ status: GroupStudentStatus.FINISHED }),
      ]);
      repository.findFinalizedResults.mockResolvedValue([weekResult(70)]);

      await expect(service.findStudentPerformance(STUDENT_ID)).resolves.toMatchObject({
        groups: [
          expect.objectContaining({
            membershipStatus: GroupStudentStatus.FINISHED,
            averageScore: 70,
          }),
        ],
      });
    });

    it('курс и филиал отдаются вместе с группой', async () => {
      repository.findMemberships.mockResolvedValue([membership()]);

      await expect(service.findStudentPerformance(STUDENT_ID)).resolves.toMatchObject({
        groups: [expect.objectContaining({ courseId: COURSE_ID, courseTitle: 'Frontend Basic' })],
      });
    });
  });

  describe('Недели для графика (ТЗ 5.8)', () => {
    it('отдаёт слагаемые каждой недели с названием её группы', async () => {
      repository.findMemberships.mockResolvedValue([membership()]);
      repository.findFinalizedResults.mockResolvedValue([
        weekResult(106, { weekNumber: 3, bonus: 6, exam: 90 }),
      ]);

      await expect(service.findStudentPerformance(STUDENT_ID)).resolves.toMatchObject({
        weeks: [
          expect.objectContaining({
            weekNumber: 3,
            groupId: GROUP_ID,
            groupName: 'Frontend-1',
            bonus: 6,
            exam: 90,
            sum: 106,
            startDate: '2026-09-02',
            submittedAt: '2026-09-14T09:00:00.000Z',
          }),
        ],
      });
    });

    it('итоги остаются и после исключения из состава — тогда названия группы нет', async () => {
      // Отметка ссылается на студента, а не на членство (решение сессии 0018):
      // membership удалён, а WeekResult жив.
      repository.findMemberships.mockResolvedValue([]);
      repository.findFinalizedResults.mockResolvedValue([weekResult(80)]);

      const result = await service.findStudentPerformance(STUDENT_ID);

      expect(result.weeks[0]).toMatchObject({ groupId: GROUP_ID, groupName: null, sum: 80 });
      // Балл при этом не теряется — он считается по итогам, а не по членствам.
      expect(result.averageScore).toBe(80);
      expect(result.groups).toStrictEqual([]);
    });
  });

  it('отдаёт того студента, которого спросили', async () => {
    await expect(service.findStudentPerformance(STUDENT_ID)).resolves.toMatchObject({
      student: { id: STUDENT_ID, firstName: 'Нигина', lastName: 'Каримова' },
    });
    expect(repository.findFinalizedResults).toHaveBeenCalledWith(STUDENT_ID);
    expect(repository.aggregateAttendance).toHaveBeenCalledWith(STUDENT_ID);
  });
});
