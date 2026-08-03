import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AttendanceMark, GroupStudentStatus, LessonType, MessageChannel } from '@prisma/client';

import { BusinessRuleException, SortOrder } from '../common';
import { JournalQueryDto, JournalWeekSortField } from './dto';
import type {
  GroupJournalRepository,
  RosterRow,
  WeekDetailRow,
  WeekResultInput,
} from './group-journal.repository';
import { GroupJournalService } from './group-journal.service';

const GROUP_ID = '11111111-1111-1111-1111-111111111111';
const WEEK_ID = '22222222-2222-2222-2222-222222222222';
const DAY_MON = '33333333-3333-3333-3333-333333333333';
const DAY_WED = '44444444-4444-4444-4444-444444444444';
const NIGINA = '55555555-5555-5555-5555-555555555555';
const ALI = '66666666-6666-6666-6666-666666666666';
const OUTSIDER = '77777777-7777-7777-7777-777777777777';
const ACTOR_ACCOUNT_ID = '88888888-8888-8888-8888-888888888888';
const EMPLOYEE_ID = '99999999-9999-9999-9999-999999999999';

const date = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

type Day = WeekDetailRow['days'][number];
type Entry = Day['entries'][number];

const entry = (studentId: string, overrides: Partial<Entry> = {}): Entry => ({
  studentId,
  attendance: null,
  score: null,
  ...overrides,
});

const day = (id: string, iso: string, type: LessonType, entries: Entry[] = []): Day => ({
  id,
  date: date(iso),
  type,
  mentor: null,
  durationMinutes: null,
  entries,
});

/** Ментор группы: только он может стоять ведущим учебного дня (0011, 0032). */
const MENTOR_ID = '99999999-9999-4999-8999-999999999999';

const week = (overrides: Partial<WeekDetailRow> = {}): WeekDetailRow => ({
  id: WEEK_ID,
  groupId: GROUP_ID,
  weekNumber: 1,
  startDate: date('2026-09-07'),
  submittedAt: null,
  submittedBy: null,
  days: [day(DAY_MON, '2026-09-07', LessonType.LECTURE)],
  results: [],
  ...overrides,
});

const member = (
  studentId: string,
  lastName: string,
  status: GroupStudentStatus = GroupStudentStatus.ACTIVE,
): RosterRow => ({
  studentId,
  status,
  student: {
    id: studentId,
    firstName: 'Имя',
    lastName,
    phone: '+992901234567',
    photoUrl: null,
  },
});

// Настоящий экземпляр DTO, а не литерал: `skip`/`take` — вычисляемые геттеры.
const query = (overrides: Partial<JournalQueryDto> = {}): JournalQueryDto =>
  Object.assign(new JournalQueryDto(), overrides);

/** Итог конкретного студента из того, что сервис передал репозиторию. */
const resultOf = (results: WeekResultInput[], studentId: string): WeekResultInput => {
  const found = results.find((result) => result.studentId === studentId);
  if (found === undefined) throw new Error(`Итог студента ${studentId} не передан`);

  return found;
};

describe('GroupJournalService', () => {
  let repository: jest.Mocked<
    Pick<
      GroupJournalRepository,
      | 'findGroup'
      | 'findWeeks'
      | 'aggregateWeeks'
      | 'findWeek'
      | 'findRoster'
      | 'findGroupMentorIds'
      | 'findStudents'
      | 'nextWeekNumber'
      | 'findConflictingDays'
      | 'createWeek'
      | 'updateWeek'
      | 'submitWeek'
      | 'deleteWeek'
      | 'findEmployeeByAccount'
      | 'findActiveDirectors'
    >
  >;
  let service: GroupJournalService;

  beforeEach(() => {
    repository = {
      findGroup: jest.fn().mockResolvedValue({ id: GROUP_ID, name: 'Frontend-1' }),
      findGroupMentorIds: jest.fn().mockResolvedValue(new Set([MENTOR_ID])),
      findWeeks: jest.fn().mockResolvedValue({ rows: [week()], total: 1 }),
      aggregateWeeks: jest
        .fn()
        .mockResolvedValue([{ weekId: WEEK_ID, studentsCount: 2, averageSum: 91.5 }]),
      findWeek: jest.fn().mockResolvedValue(week()),
      findRoster: jest.fn().mockResolvedValue([member(NIGINA, 'Каримова')]),
      findStudents: jest.fn().mockResolvedValue([]),
      nextWeekNumber: jest.fn().mockResolvedValue(4),
      findConflictingDays: jest.fn().mockResolvedValue([]),
      createWeek: jest.fn().mockResolvedValue(week({ weekNumber: 4 })),
      updateWeek: jest.fn().mockResolvedValue(week()),
      submitWeek: jest
        .fn()
        .mockResolvedValue(week({ submittedAt: new Date('2026-09-12T17:00:00.000Z') })),
      deleteWeek: jest.fn().mockResolvedValue(undefined),
      findEmployeeByAccount: jest.fn().mockResolvedValue({ id: EMPLOYEE_ID }),
      findActiveDirectors: jest.fn().mockResolvedValue([]),
    };

    service = new GroupJournalService(repository as unknown as GroupJournalRepository);
  });

  describe('Отчёт Директору при финализации (0018)', () => {
    const DIRECTOR = {
      id: 'dir-1',
      firstName: 'Иван',
      lastName: 'Директоров',
      telegram: '@director',
      phone: null,
      email: null,
    };

    const withSender = (send: jest.Mock): GroupJournalService =>
      new GroupJournalService(repository as unknown as GroupJournalRepository, {
        send,
      });

    it('после финализации уходит адресатам с адресом канала', async () => {
      const send = jest.fn().mockResolvedValue(undefined);
      repository.findActiveDirectors.mockResolvedValue([DIRECTOR]);

      await withSender(send).submit(GROUP_ID, WEEK_ID, ACTOR_ACCOUNT_ID);

      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ channel: MessageChannel.TELEGRAM, address: '@director' }),
      );
    });

    it('директор без адреса канала пропускается', async () => {
      const send = jest.fn().mockResolvedValue(undefined);
      repository.findActiveDirectors.mockResolvedValue([{ ...DIRECTOR, telegram: null }]);

      await withSender(send).submit(GROUP_ID, WEEK_ID, ACTOR_ACCOUNT_ID);

      expect(send).not.toHaveBeenCalled();
    });

    it('сбой доставки не роняет финализацию', async () => {
      const send = jest.fn().mockRejectedValue(new Error('провайдер недоступен'));
      repository.findActiveDirectors.mockResolvedValue([DIRECTOR]);

      await expect(
        withSender(send).submit(GROUP_ID, WEEK_ID, ACTOR_ACCOUNT_ID),
      ).resolves.toBeDefined();
    });

    it('без отправителя доставка не запрашивается вовсе', async () => {
      // `service` из beforeEach построен без `MessageSender`.
      await service.submit(GROUP_ID, WEEK_ID, ACTOR_ACCOUNT_ID);

      expect(repository.findActiveDirectors).not.toHaveBeenCalled();
    });
  });

  describe('Список недель', () => {
    it('отдаёт неделю с днями, средним баллом и числом студентов', async () => {
      const result = await service.findAll(GROUP_ID, query());

      expect(result.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(result.items[0]).toMatchObject({
        weekNumber: 1,
        startDate: '2026-09-07',
        endDate: '2026-09-07',
        submitted: false,
        studentsCount: 2,
        averageSum: 91.5,
        days: [{ date: '2026-09-07', type: LessonType.LECTURE }],
      });
    });

    it('неделя без итогов отдаёт средний балл как null, а не ноль', async () => {
      // Ноль означал бы, что все написали на ноль, — это другое утверждение.
      repository.aggregateWeeks.mockResolvedValue([]);

      const result = await service.findAll(GROUP_ID, query());

      expect(result.items[0]).toMatchObject({ studentsCount: 0, averageSum: null });
    });

    it('по умолчанию от первой недели к последней', async () => {
      await service.findAll(GROUP_ID, query());

      expect(repository.findWeeks).toHaveBeenCalledWith(
        expect.objectContaining({ sort: JournalWeekSortField.WeekNumber, order: SortOrder.Asc }),
      );
    });

    it('передаёт окно страницы и фильтр финализации', async () => {
      await service.findAll(GROUP_ID, query({ page: 2, limit: 5, submitted: true }));

      expect(repository.findWeeks).toHaveBeenCalledWith({
        groupId: GROUP_ID,
        submitted: true,
        sort: JournalWeekSortField.WeekNumber,
        order: SortOrder.Asc,
        skip: 5,
        take: 5,
      });
    });

    it('404 на неизвестную группу — до запроса недель', async () => {
      repository.findGroup.mockResolvedValue(null);

      await expect(service.findAll(GROUP_ID, query())).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findWeeks).not.toHaveBeenCalled();
    });
  });

  describe('Карточка недели', () => {
    it('строит таблицу «студент × день» с разложением итога', async () => {
      repository.findWeek.mockResolvedValue(
        week({
          days: [
            day(DAY_MON, '2026-09-07', LessonType.LECTURE, [
              entry(NIGINA, { attendance: AttendanceMark.PRESENT, score: 5 }),
            ]),
            day(DAY_WED, '2026-09-09', LessonType.EXAM, [
              entry(NIGINA, { attendance: AttendanceMark.PRESENT }),
            ]),
          ],
          results: [{ studentId: NIGINA, bonus: 4, exam: 60, sum: 70 }],
        }),
      );

      const result = await service.findOne(GROUP_ID, WEEK_ID);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        student: { id: NIGINA, lastName: 'Каримова' },
        membershipStatus: GroupStudentStatus.ACTIVE,
        // Приход засчитан только за лекцию: на экзамене он не считается (ТЗ 5.8).
        attendanceScore: 1,
        homeworkScore: 5,
        exam: 60,
        bonus: 4,
        sum: 70,
      });
      expect(result.rows[0]?.entries).toEqual([
        { dayId: DAY_MON, date: '2026-09-07', attendance: AttendanceMark.PRESENT, score: 5 },
        { dayId: DAY_WED, date: '2026-09-09', attendance: AttendanceMark.PRESENT, score: null },
      ]);
    });

    it('студент без отметок отдаётся пустыми клетками, а не пропускается', async () => {
      repository.findRoster.mockResolvedValue([member(NIGINA, 'Каримова'), member(ALI, 'Ахмадов')]);

      const result = await service.findOne(GROUP_ID, WEEK_ID);

      expect(result.rows).toHaveLength(2);
      expect(result.rows.map((row) => row.sum)).toEqual([0, 0]);
    });

    it('отметки студента, ушедшего из состава, из недели не пропадают', async () => {
      // Журнал не переписывается задним числом: человек был на занятиях,
      // и вычеркнуть его из уже прошедшей недели нельзя.
      repository.findWeek.mockResolvedValue(
        week({
          days: [
            day(DAY_MON, '2026-09-07', LessonType.LECTURE, [
              entry(OUTSIDER, { attendance: AttendanceMark.PRESENT }),
            ]),
          ],
          results: [{ studentId: OUTSIDER, bonus: 0, exam: 0, sum: 1 }],
        }),
      );
      repository.findStudents.mockResolvedValue([
        {
          id: OUTSIDER,
          firstName: 'Имя',
          lastName: 'Ушедший',
          phone: '+992905555555',
          photoUrl: null,
        },
      ]);

      const result = await service.findOne(GROUP_ID, WEEK_ID);

      expect(repository.findStudents).toHaveBeenCalledWith([OUTSIDER]);
      const outsider = result.rows.find((row) => row.student.id === OUTSIDER);
      expect(outsider).toMatchObject({ membershipStatus: null, sum: 1 });
    });

    it('средний балл считается по тем, у кого есть итог', async () => {
      repository.findRoster.mockResolvedValue([member(NIGINA, 'Каримова'), member(ALI, 'Ахмадов')]);
      repository.findWeek.mockResolvedValue(
        week({
          days: [
            day(DAY_MON, '2026-09-07', LessonType.LECTURE, [
              entry(NIGINA, { attendance: AttendanceMark.PRESENT, score: 5 }),
            ]),
          ],
          // У второго студента итога нет — он в неделе не участвовал и не должен
          // тянуть среднее вниз нулём.
          results: [{ studentId: NIGINA, bonus: 0, exam: 0, sum: 6 }],
        }),
      );

      const result = await service.findOne(GROUP_ID, WEEK_ID);

      expect(result).toMatchObject({ studentsCount: 1, averageSum: 6 });
    });

    it('404 на неделю чужой группы, с отдельным сообщением про группу', async () => {
      repository.findWeek.mockResolvedValue(null);
      await expect(service.findOne(GROUP_ID, WEEK_ID)).rejects.toThrow(/Неделя не найдена/);

      repository.findGroup.mockResolvedValue(null);
      await expect(service.findOne(GROUP_ID, WEEK_ID)).rejects.toThrow(/Группа не найдена/);
    });
  });

  describe('Новая неделя', () => {
    it('заводит неделю со следующим номером и нулевыми итогами состава', async () => {
      repository.findRoster.mockResolvedValue([
        member(NIGINA, 'Каримова'),
        member(ALI, 'Ахмадов', GroupStudentStatus.LEFT),
      ]);

      await service.create(GROUP_ID, {
        startDate: '2026-09-07',
        days: [{ date: '2026-09-07' }, { date: '2026-09-09', type: LessonType.EXAM }],
      });

      expect(repository.createWeek).toHaveBeenCalledWith({
        groupId: GROUP_ID,
        weekNumber: 4,
        startDate: date('2026-09-07'),
        days: [
          {
            date: date('2026-09-07'),
            type: LessonType.LECTURE,
            mentorId: null,
            durationMinutes: null,
          },
          {
            date: date('2026-09-09'),
            type: LessonType.EXAM,
            mentorId: null,
            durationMinutes: null,
          },
        ],
        // Итог заводится действующему составу: покинувший группу в новой неделе
        // не участвует.
        studentIds: [NIGINA],
      });
    });

    it('день недели по умолчанию — лекция', async () => {
      await service.create(GROUP_ID, { startDate: '2026-09-07', days: [{ date: '2026-09-07' }] });

      expect(repository.createWeek).toHaveBeenCalledWith(
        expect.objectContaining({
          days: [
            {
              date: date('2026-09-07'),
              type: LessonType.LECTURE,
              mentorId: null,
              durationMinutes: null,
            },
          ],
        }),
      );
    });

    it('400 на день за пределами семи суток от начала недели', async () => {
      await expect(
        service.create(GROUP_ID, {
          startDate: '2026-09-07',
          days: [{ date: '2026-09-14' }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.createWeek).not.toHaveBeenCalled();
    });

    it('седьмой день недели ещё внутри неё', async () => {
      await expect(
        service.create(GROUP_ID, { startDate: '2026-09-07', days: [{ date: '2026-09-13' }] }),
      ).resolves.toBeDefined();
    });

    it('400 на день раньше начала недели', async () => {
      await expect(
        service.create(GROUP_ID, { startDate: '2026-09-07', days: [{ date: '2026-09-06' }] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400 на повтор даты в наборе дней', async () => {
      await expect(
        service.create(GROUP_ID, {
          startDate: '2026-09-07',
          days: [{ date: '2026-09-07' }, { date: '2026-09-07', type: LessonType.PRACTICE }],
        }),
      ).rejects.toThrow(/повторяются/);
    });

    it('400 на несуществующую дату', async () => {
      await expect(
        service.create(GROUP_ID, { startDate: '2026-02-30', days: [{ date: '2026-02-30' }] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('409 на день, уже входящий в другую неделю группы', async () => {
      repository.findConflictingDays.mockResolvedValue([
        { date: date('2026-09-07'), week: { weekNumber: 2 } },
      ]);

      await expect(
        service.create(GROUP_ID, { startDate: '2026-09-07', days: [{ date: '2026-09-07' }] }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.createWeek).not.toHaveBeenCalled();
    });

    it('404 на неизвестную группу — до разбора дней', async () => {
      repository.findGroup.mockResolvedValue(null);

      await expect(
        service.create(GROUP_ID, { startDate: '2026-09-07', days: [{ date: '2026-09-07' }] }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.nextWeekNumber).not.toHaveBeenCalled();
    });
  });

  describe('Правка недели', () => {
    it('проставляет посещаемость и балл, пересчитывая итог', async () => {
      await service.update(GROUP_ID, WEEK_ID, {
        entries: [
          { studentId: NIGINA, date: '2026-09-07', attendance: AttendanceMark.PRESENT, score: 4 },
        ],
      });

      const call = repository.updateWeek.mock.calls[0]?.[0];
      expect(call?.entries).toEqual([
        {
          studentId: NIGINA,
          date: date('2026-09-07'),
          attendance: AttendanceMark.PRESENT,
          score: 4,
        },
      ]);
      expect(resultOf(call?.results ?? [], NIGINA)).toMatchObject({ sum: 5 });
    });

    it('не переданное поле клетки не трогается, `null` снимает отметку', async () => {
      repository.findWeek.mockResolvedValue(
        week({
          days: [
            day(DAY_MON, '2026-09-07', LessonType.LECTURE, [
              entry(NIGINA, { attendance: AttendanceMark.PRESENT, score: 5 }),
            ]),
          ],
        }),
      );

      await service.update(GROUP_ID, WEEK_ID, {
        entries: [{ studentId: NIGINA, date: '2026-09-07', score: null }],
      });

      const call = repository.updateWeek.mock.calls[0]?.[0];
      // `attendance` в запросе нет — прежняя отметка осталась, и приход
      // по-прежнему в сумме; балл за ДЗ снят.
      expect(call?.entries?.[0]).toEqual({
        studentId: NIGINA,
        date: date('2026-09-07'),
        score: null,
      });
      expect(resultOf(call?.results ?? [], NIGINA)).toMatchObject({ sum: 1 });
    });

    it('ручные слагаемые складываются с отметками', async () => {
      repository.findWeek.mockResolvedValue(
        week({
          days: [
            day(DAY_MON, '2026-09-07', LessonType.LECTURE, [
              entry(NIGINA, { attendance: AttendanceMark.PRESENT, score: 5 }),
            ]),
          ],
        }),
      );

      await service.update(GROUP_ID, WEEK_ID, {
        results: [{ studentId: NIGINA, bonus: 4, exam: 60 }],
      });

      expect(
        resultOf(repository.updateWeek.mock.calls[0]?.[0].results ?? [], NIGINA),
      ).toMatchObject({ bonus: 4, exam: 60, sum: 70 });
    });

    it('переданный отдельно bonus не обнуляет прежний exam', async () => {
      repository.findWeek.mockResolvedValue(
        week({ results: [{ studentId: NIGINA, bonus: 1, exam: 50, sum: 51 }] }),
      );

      await service.update(GROUP_ID, WEEK_ID, { results: [{ studentId: NIGINA, bonus: 3 }] });

      expect(
        resultOf(repository.updateWeek.mock.calls[0]?.[0].results ?? [], NIGINA),
      ).toMatchObject({ bonus: 3, exam: 50, sum: 53 });
    });

    it('убранный день уносит свои баллы из итога', async () => {
      repository.findWeek.mockResolvedValue(
        week({
          days: [
            day(DAY_MON, '2026-09-07', LessonType.LECTURE, [
              entry(NIGINA, { attendance: AttendanceMark.PRESENT, score: 5 }),
            ]),
            day(DAY_WED, '2026-09-09', LessonType.LECTURE, [
              entry(NIGINA, { attendance: AttendanceMark.PRESENT, score: 3 }),
            ]),
          ],
        }),
      );

      await service.update(GROUP_ID, WEEK_ID, { days: [{ date: '2026-09-07' }] });

      // Осталась только лекция понедельника: приход 1 + ДЗ 5.
      expect(
        resultOf(repository.updateWeek.mock.calls[0]?.[0].results ?? [], NIGINA),
      ).toMatchObject({ sum: 6 });
    });

    it('итоги пересчитываются всем студентам недели, а не только затронутым', async () => {
      repository.findRoster.mockResolvedValue([member(NIGINA, 'Каримова'), member(ALI, 'Ахмадов')]);

      await service.update(GROUP_ID, WEEK_ID, {
        entries: [{ studentId: NIGINA, date: '2026-09-07', attendance: AttendanceMark.PRESENT }],
      });

      const results = repository.updateWeek.mock.calls[0]?.[0].results ?? [];
      expect(results.map((result) => result.studentId).sort()).toEqual([NIGINA, ALI].sort());
    });

    it('422 на финализированную неделю — до записи', async () => {
      repository.findWeek.mockResolvedValue(
        week({ submittedAt: new Date('2026-09-12T17:00:00.000Z') }),
      );

      await expect(
        service.update(GROUP_ID, WEEK_ID, {
          entries: [{ studentId: NIGINA, date: '2026-09-07', attendance: AttendanceMark.ABSENT }],
        }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.updateWeek).not.toHaveBeenCalled();
    });

    it('422 на отметку в день, которого в неделе нет', async () => {
      await expect(
        service.update(GROUP_ID, WEEK_ID, {
          entries: [{ studentId: NIGINA, date: '2026-09-08', attendance: AttendanceMark.PRESENT }],
        }),
      ).rejects.toThrow(/дни, которых нет в неделе/);
      expect(repository.updateWeek).not.toHaveBeenCalled();
    });

    it('422 на студента, не состоящего в группе', async () => {
      await expect(
        service.update(GROUP_ID, WEEK_ID, {
          entries: [
            { studentId: OUTSIDER, date: '2026-09-07', attendance: AttendanceMark.PRESENT },
          ],
        }),
      ).rejects.toThrow(/не состоят в этой группе/);
    });

    it('покинувшему группу отметку поставить можно — он был на занятиях', async () => {
      repository.findRoster.mockResolvedValue([
        member(NIGINA, 'Каримова', GroupStudentStatus.LEFT),
      ]);

      await expect(
        service.update(GROUP_ID, WEEK_ID, {
          entries: [{ studentId: NIGINA, date: '2026-09-07', attendance: AttendanceMark.PRESENT }],
        }),
      ).resolves.toBeDefined();
    });

    it('400 на одну и ту же клетку дважды в запросе', async () => {
      await expect(
        service.update(GROUP_ID, WEEK_ID, {
          entries: [
            { studentId: NIGINA, date: '2026-09-07', attendance: AttendanceMark.PRESENT },
            { studentId: NIGINA, date: '2026-09-07', score: 5 },
          ],
        }),
      ).rejects.toThrow(/дважды/);
    });

    it('400 на итог одного студента дважды', async () => {
      await expect(
        service.update(GROUP_ID, WEEK_ID, {
          results: [
            { studentId: NIGINA, bonus: 1 },
            { studentId: NIGINA, bonus: 2 },
          ],
        }),
      ).rejects.toThrow(/дважды/);
    });

    it('400 на сдвиг начала недели, выкидывающий существующий день за её границы', async () => {
      // Проверяется итоговое состояние: день лежит в БД, а новое начало недели
      // передано в этом же запросе.
      await expect(
        service.update(GROUP_ID, WEEK_ID, { startDate: '2026-09-14' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('не переданное начало недели лишней проверки не вызывает', async () => {
      await service.update(GROUP_ID, WEEK_ID, {});

      expect(repository.updateWeek).toHaveBeenCalledWith(
        expect.objectContaining({ startDate: undefined, days: undefined, entries: undefined }),
      );
    });
  });

  describe('Отметить всех присутствующими', () => {
    it('заполняет пустые клетки действующего состава', async () => {
      repository.findRoster.mockResolvedValue([member(NIGINA, 'Каримова'), member(ALI, 'Ахмадов')]);
      repository.findWeek.mockResolvedValue(
        week({
          days: [
            day(DAY_MON, '2026-09-07', LessonType.LECTURE),
            day(DAY_WED, '2026-09-09', LessonType.LECTURE),
          ],
        }),
      );

      const result = await service.markAllPresent(GROUP_ID, WEEK_ID, {});

      expect(result.marked).toBe(4);
      expect(repository.updateWeek.mock.calls[0]?.[0].entries).toHaveLength(4);
    });

    it('уже проставленный пропуск не переписывается', async () => {
      // Иначе кнопка стирала бы работу, а восстановить отметки было бы неоткуда.
      repository.findWeek.mockResolvedValue(
        week({
          days: [
            day(DAY_MON, '2026-09-07', LessonType.LECTURE, [
              entry(NIGINA, { attendance: AttendanceMark.ABSENT }),
            ]),
          ],
        }),
      );

      const result = await service.markAllPresent(GROUP_ID, WEEK_ID, {});

      expect(result.marked).toBe(0);
      expect(repository.updateWeek.mock.calls[0]?.[0].entries).toEqual([]);
    });

    it('клетка с баллом, но без посещаемости — заполняется', async () => {
      repository.findWeek.mockResolvedValue(
        week({
          days: [day(DAY_MON, '2026-09-07', LessonType.LECTURE, [entry(NIGINA, { score: 5 })])],
        }),
      );

      const result = await service.markAllPresent(GROUP_ID, WEEK_ID, {});

      expect(result.marked).toBe(1);
    });

    it('покинувший группу кнопкой не отмечается', async () => {
      repository.findRoster.mockResolvedValue([
        member(NIGINA, 'Каримова', GroupStudentStatus.LEFT),
      ]);

      const result = await service.markAllPresent(GROUP_ID, WEEK_ID, {});

      expect(result.marked).toBe(0);
    });

    it('с датой отмечается только один день', async () => {
      repository.findWeek.mockResolvedValue(
        week({
          days: [
            day(DAY_MON, '2026-09-07', LessonType.LECTURE),
            day(DAY_WED, '2026-09-09', LessonType.LECTURE),
          ],
        }),
      );

      const result = await service.markAllPresent(GROUP_ID, WEEK_ID, { date: '2026-09-09' });

      expect(result.marked).toBe(1);
      expect(repository.updateWeek.mock.calls[0]?.[0].entries).toEqual([
        {
          studentId: NIGINA,
          date: date('2026-09-09'),
          attendance: AttendanceMark.PRESENT,
        },
      ]);
    });

    it('422 на дату, которой в неделе нет', async () => {
      await expect(
        service.markAllPresent(GROUP_ID, WEEK_ID, { date: '2026-09-08' }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
    });

    it('422 на финализированную неделю', async () => {
      repository.findWeek.mockResolvedValue(
        week({ submittedAt: new Date('2026-09-12T17:00:00.000Z') }),
      );

      await expect(service.markAllPresent(GROUP_ID, WEEK_ID, {})).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
    });
  });

  describe('Финализация недели', () => {
    const scoredWeek = (): WeekDetailRow =>
      week({
        weekNumber: 3,
        days: [
          day(DAY_MON, '2026-09-07', LessonType.LECTURE, [
            entry(NIGINA, { attendance: AttendanceMark.PRESENT, score: 5 }),
            entry(ALI, { attendance: AttendanceMark.ABSENT, score: 1 }),
          ]),
        ],
        results: [
          { studentId: NIGINA, bonus: 4, exam: 95, sum: 0 },
          { studentId: ALI, bonus: 0, exam: 50, sum: 0 },
        ],
      });

    beforeEach(() => {
      repository.findRoster.mockResolvedValue([member(NIGINA, 'Каримова'), member(ALI, 'Ахмадов')]);
      repository.findWeek.mockResolvedValue(scoredWeek());
      repository.submitWeek.mockResolvedValue(
        week({ weekNumber: 3, submittedAt: new Date('2026-09-12T17:00:00.000Z') }),
      );
    });

    it('начисляет коины по порогам ТЗ 5.9 и собирает отчёт', async () => {
      const result = await service.submit(GROUP_ID, WEEK_ID, ACTOR_ACCOUNT_ID);

      // Нигина: приход 1 + ДЗ 5 + экзамен 95 + бонус 4 = 105 → 5 коинов.
      // Али: приход 0 + ДЗ 1 + экзамен 50 = 51 → ничего.
      const call = repository.submitWeek.mock.calls[0]?.[0];
      expect(call?.awards).toEqual([
        { studentId: NIGINA, amount: 5, reason: 'Итог недели 3: 105 баллов' },
      ]);
      expect(result.report).toMatchObject({
        groupName: 'Frontend-1',
        weekNumber: 3,
        coinsAwarded: 5,
        awards: [{ studentId: NIGINA, fullName: 'Каримова Имя', sum: 105, coins: 5 }],
      });
    });

    it('итоги пишутся всем, включая тех, кому коины не положены', async () => {
      await service.submit(GROUP_ID, WEEK_ID, ACTOR_ACCOUNT_ID);

      const results = repository.submitWeek.mock.calls[0]?.[0].results ?? [];
      expect(resultOf(results, NIGINA)).toMatchObject({ sum: 105 });
      expect(resultOf(results, ALI)).toMatchObject({ sum: 51 });
    });

    it('финализировавший берётся из токена', async () => {
      await service.submit(GROUP_ID, WEEK_ID, ACTOR_ACCOUNT_ID);

      expect(repository.findEmployeeByAccount).toHaveBeenCalledWith(ACTOR_ACCOUNT_ID);
      expect(repository.submitWeek).toHaveBeenCalledWith(
        expect.objectContaining({ submittedById: EMPLOYEE_ID }),
      );
    });

    it('аккаунт без профиля сотрудника финализирует без подписи', async () => {
      repository.findEmployeeByAccount.mockResolvedValue(null);

      await service.submit(GROUP_ID, WEEK_ID, ACTOR_ACCOUNT_ID);

      expect(repository.submitWeek).toHaveBeenCalledWith(
        expect.objectContaining({ submittedById: null }),
      );
    });

    it('409 на повторную финализацию', async () => {
      repository.findWeek.mockResolvedValue(
        week({ submittedAt: new Date('2026-09-12T17:00:00.000Z') }),
      );

      await expect(service.submit(GROUP_ID, WEEK_ID, ACTOR_ACCOUNT_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(repository.submitWeek).not.toHaveBeenCalled();
    });

    it('422 на неделю без учебных дней', async () => {
      repository.findWeek.mockResolvedValue(week({ days: [] }));

      await expect(service.submit(GROUP_ID, WEEK_ID, ACTOR_ACCOUNT_ID)).rejects.toThrow(
        /нет учебных дней/,
      );
      expect(repository.submitWeek).not.toHaveBeenCalled();
    });

    it('неделя без набравших порог финализируется без начислений', async () => {
      repository.findWeek.mockResolvedValue(week({ results: [] }));

      const result = await service.submit(GROUP_ID, WEEK_ID, ACTOR_ACCOUNT_ID);

      expect(repository.submitWeek).toHaveBeenCalledWith(expect.objectContaining({ awards: [] }));
      expect(result.report.coinsAwarded).toBe(0);
    });
  });

  describe('Удаление недели', () => {
    it('удаляет открытую неделю', async () => {
      const result = await service.remove(GROUP_ID, WEEK_ID);

      expect(result).toEqual({ id: WEEK_ID, groupId: GROUP_ID, weekNumber: 1 });
      expect(repository.deleteWeek).toHaveBeenCalledWith(WEEK_ID);
    });

    it('422 на финализированную неделю: коины по ней уже выданы', async () => {
      repository.findWeek.mockResolvedValue(
        week({ submittedAt: new Date('2026-09-12T17:00:00.000Z') }),
      );

      await expect(service.remove(GROUP_ID, WEEK_ID)).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.deleteWeek).not.toHaveBeenCalled();
    });

    it('404 на неделю чужой группы', async () => {
      repository.findWeek.mockResolvedValue(null);

      await expect(service.remove(GROUP_ID, WEEK_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('GroupJournalService — ведущий и часы учебного дня (ТЗ 5.16, решение 0032)', () => {
  const GROUP = '11111111-1111-1111-1111-111111111111';
  const OUTSIDER = '88888888-8888-4888-8888-888888888888';

  let repository: jest.Mocked<
    Pick<
      GroupJournalRepository,
      | 'findGroup'
      | 'findGroupMentorIds'
      | 'findRoster'
      | 'nextWeekNumber'
      | 'findConflictingDays'
      | 'createWeek'
      | 'findStudents'
    >
  >;
  let service: GroupJournalService;

  beforeEach(() => {
    repository = {
      findGroup: jest.fn().mockResolvedValue({ id: GROUP, name: 'Frontend-1' }),
      findGroupMentorIds: jest.fn().mockResolvedValue(new Set([MENTOR_ID])),
      findRoster: jest.fn().mockResolvedValue([]),
      nextWeekNumber: jest.fn().mockResolvedValue(1),
      findConflictingDays: jest.fn().mockResolvedValue([]),
      createWeek: jest.fn().mockResolvedValue(week({ groupId: GROUP })),
      findStudents: jest.fn().mockResolvedValue([]),
    };

    service = new GroupJournalService(repository as unknown as GroupJournalRepository);
  });

  it('записывает ведущего и длительность занятия', async () => {
    await service.create(GROUP, {
      startDate: '2026-09-07',
      days: [{ date: '2026-09-07', mentorId: MENTOR_ID, durationMinutes: 90 }],
    });

    expect(repository.createWeek).toHaveBeenCalledWith(
      expect.objectContaining({
        days: [expect.objectContaining({ mentorId: MENTOR_ID, durationMinutes: 90 })],
      }),
    );
  });

  it('день без ведущего и длительности — законное состояние, а не отказ', async () => {
    await service.create(GROUP, { startDate: '2026-09-07', days: [{ date: '2026-09-07' }] });

    expect(repository.createWeek).toHaveBeenCalledWith(
      expect.objectContaining({
        days: [expect.objectContaining({ mentorId: null, durationMinutes: null })],
      }),
    );
  });

  it('422 на постороннего сотрудника: вести занятие может только ментор группы', async () => {
    await expect(
      service.create(GROUP, {
        startDate: '2026-09-07',
        days: [{ date: '2026-09-07', mentorId: OUTSIDER, durationMinutes: 90 }],
      }),
    ).rejects.toBeInstanceOf(BusinessRuleException);
    expect(repository.createWeek).not.toHaveBeenCalled();
  });

  it('менторы группы спрашиваются одним запросом на весь набор дней', async () => {
    await service.create(GROUP, {
      startDate: '2026-09-07',
      days: [
        { date: '2026-09-07', mentorId: MENTOR_ID, durationMinutes: 90 },
        { date: '2026-09-09', mentorId: MENTOR_ID, durationMinutes: 90 },
      ],
    });

    expect(repository.findGroupMentorIds).toHaveBeenCalledTimes(1);
  });

  it('без ведущих состав менторов вообще не спрашивается', async () => {
    await service.create(GROUP, { startDate: '2026-09-07', days: [{ date: '2026-09-07' }] });

    expect(repository.findGroupMentorIds).not.toHaveBeenCalled();
  });

  it('пустая строка снимает ведущего — правило пустой строки (0011)', async () => {
    await service.create(GROUP, {
      startDate: '2026-09-07',
      days: [{ date: '2026-09-07', mentorId: '', durationMinutes: 90 }],
    });

    expect(repository.createWeek).toHaveBeenCalledWith(
      expect.objectContaining({
        days: [expect.objectContaining({ mentorId: null, durationMinutes: 90 })],
      }),
    );
  });
});
