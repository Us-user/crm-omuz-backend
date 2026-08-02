import { BadRequestException } from '@nestjs/common';
import { GroupFormat, GroupStatus, LessonType, WeekDay } from '@prisma/client';

import type { TimetableQueryDto } from './dto';
import { TimetableView } from './timetable';
import type {
  TimetableJournalParams,
  TimetableJournalRow,
  TimetableSlotParams,
  TimetableSlotRow,
} from './timetable.repository';
import { TimetableService } from './timetable.service';

const utc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const slotRow = (overrides: Partial<TimetableSlotRow> = {}): TimetableSlotRow => ({
  id: 'slot-1',
  dayOfWeek: WeekDay.MONDAY,
  startMinute: 600,
  endMinute: 720,
  group: {
    id: 'group-1',
    name: 'Frontend-1',
    format: GroupFormat.OFFLINE,
    status: GroupStatus.ACTIVE,
    startDate: null,
    endDate: null,
    course: { id: 'course-1', title: 'Frontend' },
    branch: { id: 'branch-1', name: 'Садбарг' },
  },
  room: { id: 'room-1', name: '101' },
  mentor: { id: 'mentor-1', firstName: 'Фаррух', lastName: 'Раҳимов', middleName: null },
  ...overrides,
});

const query = (overrides: Partial<TimetableQueryDto> = {}): TimetableQueryDto => ({
  view: TimetableView.Week,
  ...overrides,
});

interface Repo {
  findSlots: jest.Mock<Promise<TimetableSlotRow[]>, [TimetableSlotParams]>;
  findJournalDays: jest.Mock<Promise<TimetableJournalRow[]>, [TimetableJournalParams]>;
}

describe('TimetableService', () => {
  let repository: Repo;
  let service: TimetableService;

  beforeEach(() => {
    repository = {
      findSlots: jest.fn().mockResolvedValue([]),
      findJournalDays: jest.fn().mockResolvedValue([]),
    };
    service = new TimetableService(repository as never);
  });

  describe('Окно', () => {
    it('week — с понедельника по воскресенье вокруг заданной даты', async () => {
      const result = await service.find(query({ date: '2026-09-16' }));

      expect([result.view, result.from, result.to]).toEqual([
        TimetableView.Week,
        '2026-09-14',
        '2026-09-20',
      ]);
      expect(result.days).toHaveLength(7);
    });

    it('day — одна дата', async () => {
      const result = await service.find(query({ view: TimetableView.Day, date: '2026-09-16' }));

      expect([result.from, result.to]).toEqual(['2026-09-16', '2026-09-16']);
      expect(result.days).toHaveLength(1);
    });

    it('month — календарный месяц целиком', async () => {
      const result = await service.find(query({ view: TimetableView.Month, date: '2026-09-16' }));

      expect([result.from, result.to]).toEqual(['2026-09-01', '2026-09-30']);
      expect(result.days).toHaveLength(30);
    });

    it('без даты окно строится вокруг сегодняшнего дня', async () => {
      const today = new Date().toISOString().slice(0, 10);

      const result = await service.find(query({ view: TimetableView.Day }));

      expect(result.from).toBe(today);
    });

    it('окно уходит в выборку обеими границами', async () => {
      await service.find(query({ date: '2026-09-16' }));

      const params = repository.findSlots.mock.calls[0]?.[0];
      expect(params?.from).toEqual(utc('2026-09-14'));
      expect(params?.to).toEqual(utc('2026-09-20'));
    });

    it('несуществующая дата — 400 до запроса', async () => {
      await expect(service.find(query({ date: '2026-02-30' }))).rejects.toThrow(
        BadRequestException,
      );
      expect(repository.findSlots).not.toHaveBeenCalled();
    });
  });

  describe('Сужение выборки', () => {
    it('у окна короче недели дни недели уходят в запрос', async () => {
      await service.find(query({ view: TimetableView.Day, date: '2026-09-16' }));

      expect(repository.findSlots.mock.calls[0]?.[0].weekDays).toEqual([WeekDay.WEDNESDAY]);
    });

    it('у месяца условия по дням недели нет — оно ничего не сужает', async () => {
      await service.find(query({ view: TimetableView.Month, date: '2026-09-16' }));

      expect(repository.findSlots.mock.calls[0]?.[0].weekDays).toBeUndefined();
    });

    it('у недели условия по дням недели тоже нет', async () => {
      await service.find(query({ date: '2026-09-16' }));

      expect(repository.findSlots.mock.calls[0]?.[0].weekDays).toBeUndefined();
    });

    it('доменные фильтры передаются как есть', async () => {
      await service.find(
        query({
          date: '2026-09-16',
          groupId: 'g-1',
          courseId: 'c-1',
          branchId: 'b-1',
          roomId: 'r-1',
          mentorId: 'm-1',
          format: GroupFormat.ONLINE,
        }),
      );

      expect(repository.findSlots.mock.calls[0]?.[0]).toMatchObject({
        groupId: 'g-1',
        courseId: 'c-1',
        branchId: 'b-1',
        roomId: 'r-1',
        mentorId: 'm-1',
        format: GroupFormat.ONLINE,
      });
    });
  });

  describe('Журнал', () => {
    it('спрашивается только по группам, чьи слоты попали в окно', async () => {
      repository.findSlots.mockResolvedValue([
        slotRow(),
        slotRow({ id: 'slot-2', group: { ...slotRow().group, id: 'group-2' } }),
        slotRow({ id: 'slot-3' }),
      ]);

      await service.find(query({ date: '2026-09-16' }));

      expect(repository.findJournalDays).toHaveBeenCalledTimes(1);
      expect(repository.findJournalDays.mock.calls[0]?.[0].groupIds).toEqual([
        'group-1',
        'group-2',
      ]);
    });

    it('пустое окно журнал не спрашивает', async () => {
      await service.find(query({ date: '2026-09-16' }));

      expect(repository.findJournalDays).not.toHaveBeenCalled();
    });

    it('тип и «проведено» доезжают до ячейки', async () => {
      repository.findSlots.mockResolvedValue([slotRow()]);
      repository.findJournalDays.mockResolvedValue([
        { date: utc('2026-09-14'), type: LessonType.EXAM, week: { groupId: 'group-1' } },
      ]);

      const result = await service.find(query({ date: '2026-09-16' }));
      const lesson = result.days[0]?.lessons[0];

      expect(lesson?.type).toBe(LessonType.EXAM);
      expect(lesson?.held).toBe(true);
    });
  });

  describe('Ответ', () => {
    it('время отдаётся как HH:MM, а не минутами', async () => {
      repository.findSlots.mockResolvedValue([slotRow()]);

      const result = await service.find(query({ date: '2026-09-16' }));
      const lesson = result.days[0]?.lessons[0];

      expect([lesson?.startTime, lesson?.endTime]).toEqual(['10:00', '12:00']);
    });

    it('курс отдаётся названием, а не заголовком Prisma', async () => {
      repository.findSlots.mockResolvedValue([slotRow()]);

      const result = await service.find(query({ date: '2026-09-16' }));

      expect(result.days[0]?.lessons[0]?.course).toEqual({ id: 'course-1', name: 'Frontend' });
    });

    it('total считает занятия всех дней окна', async () => {
      repository.findSlots.mockResolvedValue([slotRow()]);

      const result = await service.find(query({ view: TimetableView.Month, date: '2026-09-16' }));

      // Понедельники сентября 2026: 7, 14, 21, 28.
      expect(result.total).toBe(4);
    });

    it('пустой день остаётся в ряду', async () => {
      const result = await service.find(query({ date: '2026-09-16' }));

      expect(result.total).toBe(0);
      expect(result.days.map((day) => day.date)).toEqual([
        '2026-09-14',
        '2026-09-15',
        '2026-09-16',
        '2026-09-17',
        '2026-09-18',
        '2026-09-19',
        '2026-09-20',
      ]);
    });

    it('сроки группы сужают показ внутри окна', async () => {
      repository.findSlots.mockResolvedValue([
        slotRow({
          group: { ...slotRow().group, startDate: utc('2026-09-15'), endDate: null },
        }),
      ]);

      const result = await service.find(query({ date: '2026-09-16' }));

      // Понедельник окна — 14 сентября, до начала обучения.
      expect(result.total).toBe(0);
    });

    it('занятие онлайн отдаётся без аудитории', async () => {
      repository.findSlots.mockResolvedValue([
        slotRow({
          room: null,
          mentor: null,
          group: { ...slotRow().group, format: GroupFormat.ONLINE },
        }),
      ]);

      const result = await service.find(query({ date: '2026-09-16' }));
      const lesson = result.days[0]?.lessons[0];

      expect(lesson?.room).toBeNull();
      expect(lesson?.mentor).toBeNull();
    });
  });
});
