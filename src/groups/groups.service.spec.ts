import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DurationUnit, GroupFormat, GroupStatus } from '@prisma/client';

import { BusinessRuleException, SortOrder } from '../common';
import { GroupQueryDto, GroupSortField } from './dto';
import type { GroupActivityRows, GroupRow, GroupsRepository } from './groups.repository';
import { GroupsService } from './groups.service';

const GROUP_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_GROUP_ID = '66666666-6666-6666-6666-666666666666';
const BRANCH_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_BRANCH_ID = '33333333-3333-3333-3333-333333333333';
const COURSE_ID = '44444444-4444-4444-4444-444444444444';
const OTHER_COURSE_ID = '55555555-5555-5555-5555-555555555555';

const row = (overrides: Partial<GroupRow> = {}): GroupRow => ({
  id: GROUP_ID,
  name: 'Frontend-1',
  description: null,
  course: { id: COURSE_ID, title: 'Frontend Basic', isLastCourse: false },
  branch: { id: BRANCH_ID, name: 'Sadbarg' },
  format: GroupFormat.OFFLINE,
  startDate: new Date('2026-09-01T00:00:00.000Z'),
  endDate: new Date('2026-09-30T00:00:00.000Z'),
  durationValue: 1,
  durationUnit: DurationUnit.MONTH,
  capacity: 16,
  status: GroupStatus.RECRUITING,
  telegramUrl: null,
  // «Набрано» из «Required students = набрано/вместимость» (ТЗ 5.5).
  _count: { students: 0 },
  createdAt: new Date('2026-07-27T10:00:00.000Z'),
  ...overrides,
});

// Настоящий экземпляр DTO, а не литерал: `skip`/`take` — вычисляемые геттеры,
// и подделанные значения скрыли бы ошибку в переводе страницы в окно выборки.
const query = (overrides: Partial<GroupQueryDto> = {}): GroupQueryDto =>
  Object.assign(new GroupQueryDto(), overrides);

const validBody = {
  name: 'Frontend-1',
  courseId: COURSE_ID,
  branchId: BRANCH_ID,
};

describe('GroupsService', () => {
  let repository: jest.Mocked<
    Pick<
      GroupsRepository,
      | 'findMany'
      | 'findById'
      | 'findByName'
      | 'findBranch'
      | 'findCourse'
      | 'countScheduleSlotsWithRoom'
      | 'countStudents'
      | 'findActivity'
      | 'create'
      | 'update'
      | 'delete'
    >
  >;
  let service: GroupsService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findById: jest.fn().mockResolvedValue(row()),
      findByName: jest.fn().mockResolvedValue(null),
      findBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID, name: 'Sadbarg' }),
      findCourse: jest.fn().mockResolvedValue({ id: COURSE_ID, title: 'Frontend Basic' }),
      countScheduleSlotsWithRoom: jest.fn().mockResolvedValue(0),
      countStudents: jest.fn().mockResolvedValue(0),
      findActivity: jest.fn().mockResolvedValue({ members: [], results: [] }),
      create: jest.fn().mockImplementation(() => Promise.resolve(row())),
      update: jest.fn().mockImplementation(() => Promise.resolve(row())),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    service = new GroupsService(repository as unknown as GroupsRepository);
  });

  describe('Список и карточка', () => {
    it('отдаёт группу вместе с курсом и филиалом', async () => {
      const result = await service.findAll(query());

      expect(result.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(result.items[0]).toMatchObject({
        name: 'Frontend-1',
        course: { id: COURSE_ID, title: 'Frontend Basic', isLastCourse: false },
        branch: { id: BRANCH_ID, name: 'Sadbarg' },
      });
    });

    it('даты отдаются календарными, без времени и часового пояса', async () => {
      const result = await service.findAll(query());

      expect(result.items[0]).toMatchObject({
        startDate: '2026-09-01',
        endDate: '2026-09-30',
        createdAt: '2026-07-27T10:00:00.000Z',
      });
    });

    it('незаполненные сроки и вместимость отдаются как null, а не undefined', async () => {
      repository.findById.mockResolvedValue(
        row({ startDate: null, endDate: null, durationValue: null, capacity: null }),
      );

      const group = await service.findOne(GROUP_ID);

      expect(group.startDate).toBeNull();
      expect(group.endDate).toBeNull();
      expect(group.durationValue).toBeNull();
      expect(group.capacity).toBeNull();
    });

    it('передаёт репозиторию окно страницы и все три фильтра ТЗ 5.5', async () => {
      await service.findAll(
        query({
          page: 3,
          limit: 10,
          branchId: BRANCH_ID,
          courseId: COURSE_ID,
          status: GroupStatus.ACTIVE,
          sort: GroupSortField.StartDate,
          order: SortOrder.Desc,
        }),
      );

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20,
          take: 10,
          branchId: BRANCH_ID,
          courseId: COURSE_ID,
          status: GroupStatus.ACTIVE,
          sort: GroupSortField.StartDate,
          order: SortOrder.Desc,
        }),
      );
    });

    it('404 на неизвестную группу', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findOne(GROUP_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('Создание', () => {
    it('создаёт группу и разбирает сроки в календарные даты', async () => {
      await service.create({ ...validBody, startDate: '2026-09-01', endDate: '2026-09-30' });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Frontend-1',
          courseId: COURSE_ID,
          branchId: BRANCH_ID,
          startDate: new Date('2026-09-01T00:00:00.000Z'),
          endDate: new Date('2026-09-30T00:00:00.000Z'),
        }),
      );
    });

    it('незаполненные поля уходят в БД как null, а не undefined', async () => {
      await service.create(validBody);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          description: null,
          startDate: null,
          endDate: null,
          durationValue: null,
          capacity: null,
          telegramUrl: null,
        }),
      );
    });

    it('422 на несуществующий курс в теле запроса', async () => {
      repository.findCourse.mockResolvedValue(null);

      await expect(service.create(validBody)).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('422 на несуществующий филиал в теле запроса', async () => {
      repository.findBranch.mockResolvedValue(null);

      await expect(service.create(validBody)).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('409 на тёзку в том же филиале, без учёта регистра', async () => {
      repository.findByName.mockResolvedValue({ id: 'other', name: 'Frontend-1' });

      await expect(service.create({ ...validBody, name: 'frontend-1' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('тёзка ищется именно в филиале из запроса', async () => {
      await service.create({ ...validBody, branchId: OTHER_BRANCH_ID });

      expect(repository.findByName).toHaveBeenCalledWith(OTHER_BRANCH_ID, 'Frontend-1');
    });

    it('400, если дата окончания раньше даты начала', async () => {
      const error = await service
        .create({ ...validBody, startDate: '2026-09-30', endDate: '2026-09-01' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('совпадающие даты начала и окончания допустимы (однодневная группа)', async () => {
      await expect(
        service.create({ ...validBody, startDate: '2026-09-01', endDate: '2026-09-01' }),
      ).resolves.toMatchObject({ id: GROUP_ID });
    });

    it('400 на несуществующую дату (30 февраля)', async () => {
      await expect(
        service.create({ ...validBody, startDate: '2026-02-30' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400 на единицу длительности без самого значения', async () => {
      await expect(
        service.create({ ...validBody, durationUnit: DurationUnit.WEEK }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('длительность парой доходит до репозитория', async () => {
      await service.create({ ...validBody, durationValue: 6, durationUnit: DurationUnit.WEEK });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ durationValue: 6, durationUnit: DurationUnit.WEEK }),
      );
    });
  });

  describe('Правка', () => {
    it('переименование в собственное название не считается конфликтом', async () => {
      repository.findByName.mockResolvedValue({ id: GROUP_ID, name: 'Frontend-1' });

      await expect(service.update(GROUP_ID, { name: 'frontend-1' })).resolves.toMatchObject({
        id: GROUP_ID,
      });
    });

    it('без смены названия и филиала тёзку не ищем', async () => {
      await service.update(GROUP_ID, { status: GroupStatus.ACTIVE });

      expect(repository.findByName).not.toHaveBeenCalled();
    });

    it('переносит группу в другой филиал и ищет тёзку в филиале назначения', async () => {
      repository.findBranch.mockResolvedValue({ id: OTHER_BRANCH_ID, name: 'Profsous' });

      await service.update(GROUP_ID, { branchId: OTHER_BRANCH_ID });

      expect(repository.findByName).toHaveBeenCalledWith(OTHER_BRANCH_ID, 'Frontend-1');
      expect(repository.update).toHaveBeenCalledWith(
        GROUP_ID,
        expect.objectContaining({ branchId: OTHER_BRANCH_ID }),
      );
    });

    it('409 на перенос, если в филиале назначения такая группа уже есть', async () => {
      repository.findBranch.mockResolvedValue({ id: OTHER_BRANCH_ID, name: 'Profsous' });
      repository.findByName.mockResolvedValue({ id: 'other', name: 'Frontend-1' });

      await expect(service.update(GROUP_ID, { branchId: OTHER_BRANCH_ID })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('422 на перенос, если занятия стоят в аудиториях текущего филиала', async () => {
      repository.findBranch.mockResolvedValue({ id: OTHER_BRANCH_ID, name: 'Profsous' });
      repository.countScheduleSlotsWithRoom.mockResolvedValue(2);

      await expect(service.update(GROUP_ID, { branchId: OTHER_BRANCH_ID })).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('расписание без аудиторий переносу не мешает', async () => {
      repository.findBranch.mockResolvedValue({ id: OTHER_BRANCH_ID, name: 'Profsous' });

      await service.update(GROUP_ID, { branchId: OTHER_BRANCH_ID });

      expect(repository.countScheduleSlotsWithRoom).toHaveBeenCalledWith(GROUP_ID);
      expect(repository.update).toHaveBeenCalled();
    });

    it('без смены филиала расписание не проверяется', async () => {
      await service.update(GROUP_ID, { name: 'Frontend-1 (вечер)' });

      expect(repository.countScheduleSlotsWithRoom).not.toHaveBeenCalled();
    });

    it('переводит группу на другой курс', async () => {
      repository.findCourse.mockResolvedValue({ id: OTHER_COURSE_ID, title: 'Frontend Advanced' });

      await service.update(GROUP_ID, { courseId: OTHER_COURSE_ID });

      expect(repository.update).toHaveBeenCalledWith(
        GROUP_ID,
        expect.objectContaining({ courseId: OTHER_COURSE_ID }),
      );
    });

    it('422 на перевод на несуществующий курс', async () => {
      repository.findCourse.mockResolvedValue(null);

      await expect(service.update(GROUP_ID, { courseId: OTHER_COURSE_ID })).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('тот же курс в теле не вызывает лишней проверки', async () => {
      await service.update(GROUP_ID, { courseId: COURSE_ID });

      expect(repository.findCourse).not.toHaveBeenCalled();
    });

    it('новая дата окончания сверяется с датой начала, лежащей в БД', async () => {
      // В БД начало 2026-09-01; передаём только окончание — и оно раньше.
      await expect(service.update(GROUP_ID, { endDate: '2026-08-01' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('пустая строка снимает дату, и порядок сроков тогда не проверяется', async () => {
      await service.update(GROUP_ID, { startDate: '', endDate: '2026-08-01' });

      expect(repository.update).toHaveBeenCalledWith(
        GROUP_ID,
        expect.objectContaining({
          startDate: null,
          endDate: new Date('2026-08-01T00:00:00.000Z'),
        }),
      );
    });

    it('не переданные сроки остаются undefined — колонки не трогаются', async () => {
      await service.update(GROUP_ID, { capacity: 20 });

      const [, patch] = repository.update.mock.calls[0] ?? [];
      expect(patch).toMatchObject({ capacity: 20 });
      expect(patch?.startDate).toBeUndefined();
      expect(patch?.endDate).toBeUndefined();
    });

    it('пустая строка очищает описание и ссылку на чат', async () => {
      await service.update(GROUP_ID, { description: '', telegramUrl: '' });

      expect(repository.update).toHaveBeenCalledWith(
        GROUP_ID,
        expect.objectContaining({ description: null, telegramUrl: null }),
      );
    });

    it('единицу длительности можно сменить, если значение уже лежит в БД', async () => {
      await service.update(GROUP_ID, { durationUnit: DurationUnit.WEEK });

      expect(repository.update).toHaveBeenCalledWith(
        GROUP_ID,
        expect.objectContaining({ durationUnit: DurationUnit.WEEK }),
      );
    });

    it('400 на смену единицы длительности, если значения нет ни в теле, ни в БД', async () => {
      repository.findById.mockResolvedValue(row({ durationValue: null }));

      await expect(
        service.update(GROUP_ID, { durationUnit: DurationUnit.WEEK }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('статус меняется без ограничений на порядок переходов', async () => {
      repository.update.mockResolvedValue(row({ status: GroupStatus.FINISHED }));

      await expect(
        service.update(GROUP_ID, { status: GroupStatus.FINISHED }),
      ).resolves.toMatchObject({ status: GroupStatus.FINISHED });
    });

    it('404 на правку неизвестной группы', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.update(GROUP_ID, { capacity: 20 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('Удаление', () => {
    it('удаляет группу и называет удалённое', async () => {
      await expect(service.remove(GROUP_ID)).resolves.toEqual({
        id: GROUP_ID,
        name: 'Frontend-1',
      });
      expect(repository.delete).toHaveBeenCalledWith(GROUP_ID);
    });

    it('404 на удаление неизвестной группы', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.remove(GROUP_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('409 на группу с составом — вместе с ней исчезла бы учебная история', async () => {
      repository.countStudents.mockResolvedValue(7);

      await expect(service.remove(GROUP_ID)).rejects.toMatchObject({
        response: { message: expect.stringContaining('(7)') },
      });
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('закрытые членства тоже держат группу: считаются все, а не только активные', async () => {
      // Репозиторий считает без фильтра по статусу — сервису достаточно
      // ненулевого числа, чтобы отказать.
      repository.countStudents.mockResolvedValue(1);

      await expect(service.remove(GROUP_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(repository.countStudents).toHaveBeenCalledWith(GROUP_ID);
    });
  });

  describe('Набрано/вместимость (ТЗ 5.5)', () => {
    it('отдаёт «набрано» рядом с вместимостью', async () => {
      repository.findById.mockResolvedValue(row({ capacity: 16, _count: { students: 12 } }));

      await expect(service.findOne(GROUP_ID)).resolves.toMatchObject({
        capacity: 16,
        enrolledCount: 12,
      });
    });

    it('пустая группа отдаёт ноль, а не пропускает поле', async () => {
      const result = await service.findOne(GROUP_ID);

      expect(result.enrolledCount).toBe(0);
    });
  });

  describe('Категории активности и Passing students (ТЗ 5.5)', () => {
    /** Действующий состав и итоги закрытых недель — как их отдаёт репозиторий. */
    const activity = (
      members: string[],
      results: { studentId: string; sum: number; groupId?: string }[] = [],
    ): GroupActivityRows => ({
      members: members.map((studentId) => ({ groupId: GROUP_ID, studentId })),
      results: results.map(({ studentId, sum, groupId }) => ({
        groupId: groupId ?? GROUP_ID,
        studentId,
        sum,
      })),
    });

    it('раскладывает действующий состав по категориям', async () => {
      repository.findActivity.mockResolvedValue(
        activity(
          ['s1', 's2', 's3'],
          [
            { studentId: 's1', sum: 100 },
            { studentId: 's1', sum: 96 },
            { studentId: 's2', sum: 82 },
            { studentId: 's3', sum: 30 },
          ],
        ),
      );

      const group = await service.findOne(GROUP_ID);

      expect(group.activity).toStrictEqual({
        chatGpt: 1,
        handsome: 1,
        advanced: 0,
        kettle: 0,
        blackList: 1,
        unscored: 0,
      });
    });

    it('студент без закрытых недель идёт в unscored, а не в Black list', async () => {
      // «Не оценён» и «не справляется» — разные вещи; вторая испортила бы
      // отчёт по группе, которая просто ещё не финализировала ни одной недели.
      repository.findActivity.mockResolvedValue(
        activity(['s1', 's2'], [{ studentId: 's1', sum: 90 }]),
      );

      const group = await service.findOne(GROUP_ID);

      expect(group.activity.unscored).toBe(1);
      expect(group.activity.blackList).toBe(0);
      expect(group.activity.chatGpt).toBe(0);
      expect(group.activity.handsome).toBe(1);
    });

    it('«Passing students» считает тех, кто не в Black list', async () => {
      repository.findActivity.mockResolvedValue(
        activity(
          ['s1', 's2', 's3', 's4'],
          [
            { studentId: 's1', sum: 45 },
            { studentId: 's2', sum: 44 },
            { studentId: 's3', sum: 100 },
          ],
        ),
      );

      const group = await service.findOne(GROUP_ID);

      // s1 (45) и s3 (100) успевают; s2 (44) в Black list, s4 не оценён.
      expect(group.passingCount).toBe(2);
    });

    it('балл считается по неделям этой группы, а не по всем', async () => {
      // Счётчики стоят на карточке группы: учёба человека на соседнем курсе
      // сдвигать их не должна.
      repository.findActivity.mockResolvedValue(
        activity(
          ['s1'],
          [
            { studentId: 's1', sum: 100 },
            { studentId: 's1', sum: 10, groupId: OTHER_GROUP_ID },
          ],
        ),
      );

      const group = await service.findOne(GROUP_ID);

      expect(group.activity.chatGpt).toBe(1);
      expect(group.passingCount).toBe(1);
    });

    it('покинувшие в счётчики не идут: считается действующий состав', async () => {
      // Ушедший из группы её больше не характеризует, хотя итоги его недель остались.
      repository.findActivity.mockResolvedValue(activity([], [{ studentId: 's1', sum: 100 }]));

      const group = await service.findOne(GROUP_ID);

      expect(group.activity.chatGpt).toBe(0);
      expect(group.passingCount).toBe(0);
    });

    it('пустая группа отдаёт нули, а не пропускает счётчики', async () => {
      const group = await service.findOne(GROUP_ID);

      expect(group.activity).toStrictEqual({
        chatGpt: 0,
        handsome: 0,
        advanced: 0,
        kettle: 0,
        blackList: 0,
        unscored: 0,
      });
      expect(group.passingCount).toBe(0);
    });

    it('в списке счётчики запрашиваются одной выборкой на страницу', async () => {
      repository.findMany.mockResolvedValue({
        rows: [row(), row({ id: OTHER_GROUP_ID, name: 'Python-1' })],
        total: 2,
      });
      repository.findActivity.mockResolvedValue({
        members: [
          { groupId: GROUP_ID, studentId: 's1' },
          { groupId: OTHER_GROUP_ID, studentId: 's2' },
        ],
        results: [
          { groupId: GROUP_ID, studentId: 's1', sum: 100 },
          { groupId: OTHER_GROUP_ID, studentId: 's2', sum: 50 },
        ],
      });

      const page = await service.findAll(query());

      expect(repository.findActivity).toHaveBeenCalledTimes(1);
      expect(repository.findActivity).toHaveBeenCalledWith([GROUP_ID, OTHER_GROUP_ID]);
      expect(page.items[0]?.activity.chatGpt).toBe(1);
      expect(page.items[1]?.activity.kettle).toBe(1);
    });

    it('созданной группе счётчики не запрашиваются', async () => {
      await service.create(validBody);

      expect(repository.findActivity).not.toHaveBeenCalled();
    });
  });
});
