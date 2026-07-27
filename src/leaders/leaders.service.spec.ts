import { ConflictException, NotFoundException } from '@nestjs/common';

import { BusinessRuleException, SortOrder } from '../common';
import { ActivityCategory } from '../performance/performance';
import type { CloseMonthDto, LeadersQueryDto } from './dto';
import { LeaderSortField } from './dto';
import type { ScoredStudent } from './leaders';
import type { LeaderStudentRow, LeadersRepository, MonthlyWinnerRow } from './leaders.repository';
import { LeadersService } from './leaders.service';

const ACCOUNT_ID = '00000000-0000-0000-0000-0000000000aa';
const AUTHOR_ID = '00000000-0000-0000-0000-0000000000bb';
const GROUP_ID = '22222222-2222-2222-2222-222222222222';
const COURSE_ID = '44444444-4444-4444-4444-444444444444';

const scored = (studentId: string, average: number, weeksCount = 2): ScoredStudent => ({
  studentId,
  average,
  weeksCount,
});

const studentRow = (id: string, lastName = 'Каримова'): LeaderStudentRow => ({
  id,
  firstName: 'Нигина',
  lastName,
  photoUrl: null,
  groups: [
    { group: { id: GROUP_ID, name: 'Frontend-1', course: { id: COURSE_ID, title: 'Frontend' } } },
  ],
});

// `averageScore` в БД — `Decimal`, но наружу он всегда проходит через `Number()`
// (решение сессии 0007), поэтому в тестах достаточно обычного числа.
const winnerRow = (
  overrides: Partial<Omit<MonthlyWinnerRow, 'student' | 'createdBy' | 'averageScore'>> & {
    studentId?: string;
    averageScore?: number;
  } = {},
): MonthlyWinnerRow => ({
  id: overrides.id ?? 'winner-1',
  month: overrides.month ?? new Date('2026-06-01T00:00:00.000Z'),
  place: overrides.place ?? 1,
  averageScore: (overrides.averageScore ?? 98.75) as unknown as MonthlyWinnerRow['averageScore'],
  weeksCount: overrides.weeksCount ?? 4,
  createdAt: overrides.createdAt ?? new Date('2026-07-01T09:00:00.000Z'),
  student: {
    id: overrides.studentId ?? 'student-a',
    firstName: 'Нигина',
    lastName: 'Каримова',
    photoUrl: null,
  },
  createdBy: { id: AUTHOR_ID, firstName: 'Фаррух', lastName: 'Раҳимов' },
});

const listQuery = (overrides: Partial<LeadersQueryDto> = {}): LeadersQueryDto => ({
  page: 1,
  limit: 20,
  sort: LeaderSortField.AverageScore,
  order: SortOrder.Desc,
  skip: 0,
  take: 20,
  ...overrides,
});

const closeDto = (overrides: Partial<CloseMonthDto> = {}): CloseMonthDto => ({
  month: '2026-06',
  places: 3,
  ...overrides,
});

/** Месяц, который заведомо в прошлом относительно любого прогона тестов. */
const PAST_MONTH = '2020-01';

describe('LeadersService', () => {
  let repository: jest.Mocked<
    Pick<
      LeadersRepository,
      | 'findScores'
      | 'findMonthScores'
      | 'findStudents'
      | 'findWinners'
      | 'findLatestClosedMonth'
      | 'countWinners'
      | 'createWinners'
      | 'deleteWinners'
      | 'findEmployeeByAccount'
    >
  >;
  let service: LeadersService;

  beforeEach(() => {
    repository = {
      findScores: jest.fn().mockResolvedValue([]),
      findMonthScores: jest.fn().mockResolvedValue([]),
      findStudents: jest.fn().mockResolvedValue([]),
      findWinners: jest.fn().mockResolvedValue([]),
      findLatestClosedMonth: jest.fn().mockResolvedValue(null),
      countWinners: jest.fn().mockResolvedValue(0),
      createWinners: jest.fn().mockResolvedValue([]),
      deleteWinners: jest.fn().mockResolvedValue(0),
      findEmployeeByAccount: jest.fn().mockResolvedValue({ id: AUTHOR_ID }),
    };

    service = new LeadersService(repository as unknown as LeadersRepository);
  });

  describe('Рейтинг центра (ТЗ 5.13)', () => {
    it('строит список по убыванию балла с местами и короной у первого', async () => {
      repository.findScores.mockResolvedValue([scored('a', 96.5), scored('b', 80)]);
      repository.findStudents.mockResolvedValue([studentRow('a'), studentRow('b', 'Салимов')]);

      const page = await service.findAll(listQuery());

      expect(
        page.items.map(({ student, position, isTopStudent }) => [
          student.id,
          position,
          isTopStudent,
        ]),
      ).toEqual([
        ['a', 1, true],
        ['b', 2, false],
      ]);
    });

    it('округляет балл до двух знаков и выводит категорию', async () => {
      repository.findScores.mockResolvedValue([scored('a', 87.336)]);
      repository.findStudents.mockResolvedValue([studentRow('a')]);

      const [first] = (await service.findAll(listQuery())).items;

      expect(first).toMatchObject({
        averageScore: 87.34,
        category: ActivityCategory.Handsome,
        categoryTitle: 'Handsome',
        weeksCount: 2,
      });
    });

    it('при равенстве баллов корона у обоих', async () => {
      repository.findScores.mockResolvedValue([scored('a', 90), scored('b', 90)]);
      repository.findStudents.mockResolvedValue([studentRow('a'), studentRow('b')]);

      const page = await service.findAll(listQuery());

      expect(page.items.every(({ isTopStudent, position }) => isTopStudent && position === 1)).toBe(
        true,
      );
    });

    it('отдаёт действующие группы студента строкой списка', async () => {
      repository.findScores.mockResolvedValue([scored('a', 90)]);
      repository.findStudents.mockResolvedValue([studentRow('a')]);

      const [first] = (await service.findAll(listQuery())).items;

      expect(first?.groups).toEqual([
        { id: GROUP_ID, name: 'Frontend-1', courseId: COURSE_ID, courseTitle: 'Frontend' },
      ]);
    });

    // Топ-3 один на все страницы: на второй странице экран не должен терять пьедестал.
    it('кладёт топ-3 в meta', async () => {
      repository.findScores.mockResolvedValue([
        scored('a', 100),
        scored('b', 90),
        scored('c', 80),
        scored('d', 70),
      ]);
      repository.findStudents.mockResolvedValue(['a', 'b', 'c', 'd'].map((id) => studentRow(id)));

      const page = await service.findAll(listQuery());
      const top = page.meta.top as { student: { id: string } }[];

      expect(top.map(({ student }) => student.id)).toEqual(['a', 'b', 'c']);
    });

    it('на второй странице пьедестал остаётся в meta, а строк там уже нет', async () => {
      repository.findScores.mockResolvedValue([
        scored('a', 100),
        scored('b', 90),
        scored('c', 80),
        scored('d', 70),
      ]);
      repository.findStudents.mockResolvedValue(['a', 'b', 'c', 'd'].map((id) => studentRow(id)));

      const page = await service.findAll(listQuery({ page: 2, limit: 2, skip: 2, take: 2 }));
      const top = page.meta.top as { student: { id: string } }[];

      expect(page.items.map(({ student }) => student.id)).toEqual(['c', 'd']);
      expect(top.map(({ student }) => student.id)).toEqual(['a', 'b', 'c']);
    });

    // Профили запрашиваются один раз на страницу — вместе с пьедесталом.
    it('запрашивает профили страницы и пьедестала одним запросом без повторов', async () => {
      repository.findScores.mockResolvedValue([
        scored('a', 100),
        scored('b', 90),
        scored('c', 80),
        scored('d', 70),
      ]);

      await service.findAll(listQuery({ page: 2, limit: 2, skip: 2, take: 2 }));

      expect(repository.findStudents).toHaveBeenCalledTimes(1);
      const [ids] = repository.findStudents.mock.calls[0] ?? [[]];
      expect([...ids].sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('места считаются по всему рейтингу, а не по странице', async () => {
      repository.findScores.mockResolvedValue([scored('a', 100), scored('b', 90), scored('c', 80)]);
      repository.findStudents.mockResolvedValue([studentRow('c')]);

      const page = await service.findAll(listQuery({ page: 3, limit: 1, skip: 2, take: 1 }));

      expect(page.items[0]?.position).toBe(3);
      expect(page.meta.total).toBe(3);
    });

    // `asc` показывает отстающих: категория Black list существует ровно затем,
    // чтобы их находить. Места при этом остаются настоящими.
    it('order=asc переворачивает показ, но не нумерацию', async () => {
      repository.findScores.mockResolvedValue([scored('a', 100), scored('b', 90), scored('c', 40)]);
      repository.findStudents.mockResolvedValue(['a', 'b', 'c'].map((id) => studentRow(id)));

      const page = await service.findAll(listQuery({ order: SortOrder.Asc }));

      expect(page.items.map(({ student, position }) => [student.id, position])).toEqual([
        ['c', 3],
        ['b', 2],
        ['a', 1],
      ]);
    });

    it('передаёт срез по группе и курсу в выборку', async () => {
      await service.findAll(listQuery({ groupId: GROUP_ID, courseId: COURSE_ID }));

      expect(repository.findScores).toHaveBeenCalledWith({
        groupId: GROUP_ID,
        courseId: COURSE_ID,
      });
    });

    it('пустой рейтинг не идёт за профилями', async () => {
      const page = await service.findAll(listQuery());

      expect(page.items).toEqual([]);
      expect(page.meta.total).toBe(0);
      expect(repository.findStudents).toHaveBeenCalledWith([]);
    });
  });

  describe('Победители месяца — просмотр (ТЗ 5.13)', () => {
    it('отдаёт снимок запрошенного месяца с тем, кто его закрыл', async () => {
      repository.findWinners.mockResolvedValue([winnerRow()]);

      const result = await service.findWinners({ month: '2026-06' });

      expect(result).toMatchObject({
        month: '2026-06',
        closed: true,
        closedAt: '2026-07-01T09:00:00.000Z',
        closedBy: { id: AUTHOR_ID, firstName: 'Фаррух', lastName: 'Раҳимов' },
      });
      expect(result.winners).toHaveLength(1);
    });

    it('балл снимка отдаётся числом и из него выводится категория', async () => {
      repository.findWinners.mockResolvedValue([winnerRow({ averageScore: 98.75 })]);

      const [winner] = (await service.findWinners({ month: '2026-06' })).winners;

      expect(winner).toMatchObject({
        averageScore: 98.75,
        category: ActivityCategory.ChatGpt,
        categoryTitle: 'ChatGPT',
        place: 1,
        weeksCount: 4,
      });
    });

    // «Winners of the last month» — последний закрытый, а не прошлый календарный.
    it('без месяца берёт последний закрытый', async () => {
      repository.findLatestClosedMonth.mockResolvedValue(new Date('2026-05-01T00:00:00.000Z'));
      repository.findWinners.mockResolvedValue([winnerRow({ month: new Date('2026-05-01') })]);

      const result = await service.findWinners({});

      expect(result.month).toBe('2026-05');
      expect(repository.findWinners).toHaveBeenCalledWith(new Date('2026-05-01T00:00:00.000Z'));
    });

    it('без единого закрытого месяца отдаёт пустой снимок, а не ошибку', async () => {
      const result = await service.findWinners({});

      expect(result).toEqual({
        month: null,
        closed: false,
        closedAt: null,
        closedBy: null,
        winners: [],
      });
      expect(repository.findWinners).not.toHaveBeenCalled();
    });

    // Незакрытый месяц — законное состояние, а не 404.
    it('незакрытый месяц отдаёт closed: false и пустой список', async () => {
      const result = await service.findWinners({ month: '2026-06' });

      expect(result).toMatchObject({ month: '2026-06', closed: false, winners: [] });
    });

    it('400 на несуществующий месяц в фильтре', async () => {
      await expect(service.findWinners({ month: '2026-13' })).rejects.toThrow(/Некорректный месяц/);
    });
  });

  describe('Закрытие месяца', () => {
    it('фиксирует победителей по среднему за месяц и подписывает автором из токена', async () => {
      repository.findMonthScores.mockResolvedValue([scored('a', 98.75, 4), scored('b', 80, 4)]);
      repository.createWinners.mockResolvedValue([winnerRow()]);

      const result = await service.closeMonth(closeDto({ month: PAST_MONTH }), ACCOUNT_ID);

      expect(repository.createWinners).toHaveBeenCalledWith(
        new Date(`${PAST_MONTH}-01T00:00:00.000Z`),
        [
          { studentId: 'a', place: 1, averageScore: 98.75, weeksCount: 4 },
          { studentId: 'b', place: 2, averageScore: 80, weeksCount: 4 },
        ],
        AUTHOR_ID,
      );
      expect(result.closed).toBe(true);
    });

    // Неделя относится к месяцу своей даты начала; правая граница не включается.
    it('спрашивает недели месяца отрезком до первого числа следующего', async () => {
      repository.findMonthScores.mockResolvedValue([scored('a', 90)]);

      await service.closeMonth(closeDto({ month: '2020-12' }), ACCOUNT_ID);

      expect(repository.findMonthScores).toHaveBeenCalledWith(
        new Date('2020-12-01T00:00:00.000Z'),
        new Date('2021-01-01T00:00:00.000Z'),
      );
    });

    // Ровно тот случай, ради которого сравнения идут по неокруглённому баллу:
    // показанные значения совпадают, а места — разные. Округли мы до сравнения,
    // оба оказались бы первыми.
    it('в снимок ложится округлённый балл, а места считаются по неокруглённому', async () => {
      repository.findMonthScores.mockResolvedValue([scored('a', 87.335), scored('b', 87.334)]);

      await service.closeMonth(closeDto({ month: PAST_MONTH }), ACCOUNT_ID);

      const [, winners] = repository.createWinners.mock.calls[0] ?? [];
      expect(winners).toEqual([
        { studentId: 'a', place: 1, averageScore: 87.33, weeksCount: 2 },
        { studentId: 'b', place: 2, averageScore: 87.33, weeksCount: 2 },
      ]);
    });

    it('фиксирует ровно запрошенное число мест', async () => {
      repository.findMonthScores.mockResolvedValue([
        scored('a', 100),
        scored('b', 90),
        scored('c', 80),
        scored('d', 70),
      ]);

      await service.closeMonth(closeDto({ month: PAST_MONTH, places: 2 }), ACCOUNT_ID);

      const [, winners] = repository.createWinners.mock.calls[0] ?? [];
      expect((winners as { studentId: string }[]).map(({ studentId }) => studentId)).toEqual([
        'a',
        'b',
      ]);
    });

    it('при ничьей на последнем месте в снимок попадают все, кто его занял', async () => {
      repository.findMonthScores.mockResolvedValue([
        scored('a', 100),
        scored('b', 90),
        scored('c', 90),
      ]);

      await service.closeMonth(closeDto({ month: PAST_MONTH, places: 2 }), ACCOUNT_ID);

      const [, winners] = repository.createWinners.mock.calls[0] ?? [];
      expect(winners).toHaveLength(3);
    });

    it('аккаунт без профиля сотрудника закрывает месяц без подписи', async () => {
      repository.findEmployeeByAccount.mockResolvedValue(null);
      repository.findMonthScores.mockResolvedValue([scored('a', 90)]);

      await service.closeMonth(closeDto({ month: PAST_MONTH }), ACCOUNT_ID);

      expect(repository.createWinners).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        null,
      );
    });

    it('409 на повторное закрытие — снимок не пересчитывается', async () => {
      repository.countWinners.mockResolvedValue(3);

      await expect(service.closeMonth(closeDto({ month: PAST_MONTH }), ACCOUNT_ID)).rejects.toThrow(
        ConflictException,
      );
      expect(repository.createWinners).not.toHaveBeenCalled();
      expect(repository.findMonthScores).not.toHaveBeenCalled();
    });

    // Снимок текущего месяца заморозил бы неполные данные.
    it('422 на незавершившийся месяц — до всех запросов', async () => {
      const now = new Date();
      const current = `${String(now.getUTCFullYear())}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

      await expect(service.closeMonth(closeDto({ month: current }), ACCOUNT_ID)).rejects.toThrow(
        BusinessRuleException,
      );
      expect(repository.countWinners).not.toHaveBeenCalled();
    });

    it('422 на месяц без единой финализированной недели', async () => {
      repository.findMonthScores.mockResolvedValue([]);

      await expect(service.closeMonth(closeDto({ month: PAST_MONTH }), ACCOUNT_ID)).rejects.toThrow(
        /нет ни одной финализированной недели/,
      );
      expect(repository.createWinners).not.toHaveBeenCalled();
    });

    it('400 на несуществующий месяц — до проверки закрытия', async () => {
      await expect(service.closeMonth(closeDto({ month: '2026-13' }), ACCOUNT_ID)).rejects.toThrow(
        /Некорректный месяц/,
      );
      expect(repository.countWinners).not.toHaveBeenCalled();
    });
  });

  describe('Снятие снимка месяца', () => {
    it('убирает снимок и называет число снятых строк', async () => {
      repository.deleteWinners.mockResolvedValue(3);

      await expect(service.reopenMonth('2026-06')).resolves.toEqual({
        month: '2026-06',
        removed: 3,
      });
      expect(repository.deleteWinners).toHaveBeenCalledWith(new Date('2026-06-01T00:00:00.000Z'));
    });

    it('404 на незакрытый месяц', async () => {
      await expect(service.reopenMonth('2026-06')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('400 на несуществующий месяц — до удаления', async () => {
      await expect(service.reopenMonth('2026-13')).rejects.toThrow(/Некорректный месяц/);
      expect(repository.deleteWinners).not.toHaveBeenCalled();
    });
  });
});
