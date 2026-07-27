import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { GroupStudentStatus, StudentStatus } from '@prisma/client';

import { BusinessRuleException, parseCsv, SortOrder } from '../common';
import type { AppConfigService } from '../config';
import { PhoneService } from '../phone/phone.service';
import { ExportGroupStudentsQueryDto, GroupStudentQueryDto, GroupStudentSortField } from './dto';
import type {
  CompetingMembership,
  GroupStudentRow,
  GroupStudentsRepository,
  StudentByPhone,
  StudentCandidate,
  StudentGroup,
} from './group-students.repository';
import { GroupStudentsService } from './group-students.service';

const GROUP_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_GROUP_ID = '22222222-2222-2222-2222-222222222222';
const COURSE_ID = '33333333-3333-3333-3333-333333333333';
const STUDENT_ID = '44444444-4444-4444-4444-444444444444';
const SECOND_STUDENT_ID = '55555555-5555-5555-5555-555555555555';
const MENTOR_ID = '66666666-6666-6666-6666-666666666666';

const group = (overrides: Partial<StudentGroup> = {}): StudentGroup => ({
  id: GROUP_ID,
  name: 'Frontend-1',
  courseId: COURSE_ID,
  capacity: 16,
  ...overrides,
});

const candidate = (id = STUDENT_ID): StudentCandidate => ({
  id,
  firstName: 'Нигина',
  lastName: 'Каримова',
});

const row = (overrides: Partial<GroupStudentRow> = {}): GroupStudentRow => ({
  groupId: GROUP_ID,
  studentId: STUDENT_ID,
  status: GroupStudentStatus.ACTIVE,
  statusReason: null,
  statusChangedAt: null,
  enrolledAt: new Date('2026-09-01T10:00:00.000Z'),
  student: {
    id: STUDENT_ID,
    firstName: 'Нигина',
    lastName: 'Каримова',
    phone: '+992901234567',
    photoUrl: null,
    status: StudentStatus.ACTIVE,
  },
  transferredFromGroup: null,
  ...overrides,
});

const byPhone = (overrides: Partial<StudentByPhone> = {}): StudentByPhone => ({
  id: STUDENT_ID,
  firstName: 'Нигина',
  lastName: 'Каримова',
  phone: '+992901234567',
  ...overrides,
});

/** Членство в том виде, в каком его читает правило статуса профиля (ТЗ 5.3). */
const membership = (
  status: GroupStudentStatus = GroupStudentStatus.ACTIVE,
  statusChangedAt: Date | null = null,
): { status: GroupStudentStatus; statusChangedAt: Date | null } => ({ status, statusChangedAt });

const competing = (): CompetingMembership => ({
  studentId: STUDENT_ID,
  groupId: OTHER_GROUP_ID,
  group: { name: 'Frontend-2' },
  student: { firstName: 'Нигина', lastName: 'Каримова' },
});

// Настоящий экземпляр DTO, а не литерал: `skip`/`take` — вычисляемые геттеры,
// и подделанные значения скрыли бы ошибку в переводе страницы в окно выборки.
const query = (overrides: Partial<GroupStudentQueryDto> = {}): GroupStudentQueryDto =>
  Object.assign(new GroupStudentQueryDto(), overrides);

describe('GroupStudentsService', () => {
  let repository: jest.Mocked<
    Pick<
      GroupStudentsRepository,
      | 'findMany'
      | 'findAllForExport'
      | 'findGroup'
      | 'findStudents'
      | 'findStudentsByPhones'
      | 'findOne'
      | 'findMemberships'
      | 'findCompetingMemberships'
      | 'findLeaveMentor'
      | 'countActive'
      | 'enroll'
      | 'changeStatus'
      | 'transfer'
      | 'delete'
      | 'findStudentsWithMemberships'
      | 'setStudentStatuses'
    >
  >;
  let service: GroupStudentsService;

  beforeEach(() => {
    repository = {
      // Пересчёт статуса профиля (ТЗ 5.3) идёт после каждой операции над
      // составом. По умолчанию студент уже `ACTIVE` и учится — тогда вывод
      // ничего не меняет и в БД не пишет; отдельные случаи задают своё.
      findStudentsWithMemberships: jest
        .fn()
        .mockResolvedValue([
          { id: STUDENT_ID, status: StudentStatus.ACTIVE, groups: [membership()] },
        ]),
      setStudentStatuses: jest.fn().mockResolvedValue(undefined),
      findMany: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findAllForExport: jest.fn().mockResolvedValue([row()]),
      findGroup: jest.fn().mockResolvedValue(group()),
      findStudents: jest.fn().mockResolvedValue([candidate()]),
      findStudentsByPhones: jest.fn().mockResolvedValue([byPhone()]),
      findOne: jest.fn().mockResolvedValue(row()),
      findMemberships: jest.fn().mockResolvedValue([]),
      findCompetingMemberships: jest.fn().mockResolvedValue([]),
      // Ведущий ментор группы — снимок «ментор на момент ухода» (ТЗ 5.12).
      // По умолчанию он есть: случай «группа без ведущего» задаётся отдельно.
      findLeaveMentor: jest.fn().mockResolvedValue(MENTOR_ID),
      countActive: jest.fn().mockResolvedValue(1),
      enroll: jest.fn().mockResolvedValue([row()]),
      changeStatus: jest.fn().mockResolvedValue([row()]),
      transfer: jest.fn().mockResolvedValue([row({ groupId: OTHER_GROUP_ID })]),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    // Настоящий `PhoneService`: импорт разбирает номера из файла теми же
    // правилами, что и остальные модули (ТЗ 3.1), и заглушка проверяла бы
    // не то поведение, которое увидит оператор.
    const phones = new PhoneService({ defaultPhoneRegion: 'TJ' } as AppConfigService);

    service = new GroupStudentsService(repository as unknown as GroupStudentsRepository, phones);
  });

  describe('Состав группы', () => {
    it('отдаёт членство вместе с профилем студента', async () => {
      const result = await service.findAll(GROUP_ID, query());

      expect(result.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(result.items[0]).toMatchObject({
        groupId: GROUP_ID,
        status: GroupStudentStatus.ACTIVE,
        student: { id: STUDENT_ID, lastName: 'Каримова', status: StudentStatus.ACTIVE },
      });
    });

    it('передаёт окно страницы, фильтр статуса и сортировку', async () => {
      await service.findAll(
        GROUP_ID,
        query({
          page: 2,
          limit: 5,
          status: GroupStudentStatus.LEFT,
          sort: GroupStudentSortField.EnrolledAt,
          order: SortOrder.Desc,
          search: 'каримова',
        }),
      );

      expect(repository.findMany).toHaveBeenCalledWith({
        groupId: GROUP_ID,
        search: 'каримова',
        status: GroupStudentStatus.LEFT,
        sort: GroupStudentSortField.EnrolledAt,
        order: SortOrder.Desc,
        skip: 5,
        take: 5,
      });
    });

    it('по умолчанию сортирует по имени по возрастанию', async () => {
      await service.findAll(GROUP_ID, query());

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ sort: GroupStudentSortField.Name, order: SortOrder.Asc }),
      );
    });

    it('дата и причина смены статуса уходят наружу строкой и null', async () => {
      repository.findMany.mockResolvedValue({
        rows: [
          row({
            status: GroupStudentStatus.LEFT,
            statusReason: 'Переехал',
            statusChangedAt: new Date('2026-09-15T08:30:00.000Z'),
          }),
        ],
        total: 1,
      });

      const result = await service.findAll(GROUP_ID, query());

      expect(result.items[0]).toMatchObject({
        statusReason: 'Переехал',
        statusChangedAt: '2026-09-15T08:30:00.000Z',
        transferredFrom: null,
      });
    });

    it('404 на неизвестную группу — до запроса состава', async () => {
      repository.findGroup.mockResolvedValue(null);

      await expect(service.findAll(GROUP_ID, query())).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findMany).not.toHaveBeenCalled();
    });
  });

  describe('Зачисление (ТЗ 5.5)', () => {
    it('зачисляет студентов и отдаёт «набрано»', async () => {
      repository.countActive.mockResolvedValue(12);

      const result = await service.add(GROUP_ID, { studentIds: [STUDENT_ID] });

      expect(result).toMatchObject({ groupId: GROUP_ID, enrolledCount: 12 });
      expect(result.students).toHaveLength(1);
      expect(repository.enroll).toHaveBeenCalledWith(GROUP_ID, [STUDENT_ID], expect.any(Date));
    });

    it('422 с перечислением только недостающих студентов', async () => {
      repository.findStudents.mockResolvedValue([candidate()]);

      await expect(
        service.add(GROUP_ID, { studentIds: [STUDENT_ID, SECOND_STUDENT_ID] }),
      ).rejects.toMatchObject({
        response: { details: { studentIds: [SECOND_STUDENT_ID] } },
      });
      expect(repository.enroll).not.toHaveBeenCalled();
    });

    it('404 на неизвестную группу — до поиска студентов', async () => {
      repository.findGroup.mockResolvedValue(null);

      await expect(service.add(GROUP_ID, { studentIds: [STUDENT_ID] })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.findStudents).not.toHaveBeenCalled();
    });

    it('409 на уже зачисленного, с именем в сообщении', async () => {
      repository.findMemberships.mockResolvedValue([row()]);

      await expect(service.add(GROUP_ID, { studentIds: [STUDENT_ID] })).rejects.toMatchObject({
        response: { message: expect.stringContaining('Каримова Нигина') },
      });
      expect(repository.enroll).not.toHaveBeenCalled();
    });

    it('покинувший группу зачисляется заново — закрытое членство не мешает', async () => {
      repository.findMemberships.mockResolvedValue([
        row({ status: GroupStudentStatus.LEFT, statusReason: 'Пауза' }),
      ]);

      await expect(service.add(GROUP_ID, { studentIds: [STUDENT_ID] })).resolves.toBeDefined();
      expect(repository.enroll).toHaveBeenCalled();
    });

    it('409, если студент уже учится в другой группе этого курса', async () => {
      repository.findCompetingMemberships.mockResolvedValue([competing()]);

      await expect(service.add(GROUP_ID, { studentIds: [STUDENT_ID] })).rejects.toMatchObject({
        response: { message: expect.stringContaining('Frontend-2') },
      });
      expect(repository.enroll).not.toHaveBeenCalled();
    });

    it('курс ищется по группе из пути, а сама она в счёт не идёт', async () => {
      await service.add(GROUP_ID, { studentIds: [STUDENT_ID] });

      expect(repository.findCompetingMemberships).toHaveBeenCalledWith(
        COURSE_ID,
        [STUDENT_ID],
        [GROUP_ID],
      );
    });

    it('вместимость набор не ограничивает: «Required students» — план, а не предел', async () => {
      repository.findGroup.mockResolvedValue(group({ capacity: 1 }));
      repository.findStudents.mockResolvedValue([candidate(), candidate(SECOND_STUDENT_ID)]);
      repository.countActive.mockResolvedValue(17);

      await expect(
        service.add(GROUP_ID, { studentIds: [STUDENT_ID, SECOND_STUDENT_ID] }),
      ).resolves.toMatchObject({ enrolledCount: 17 });
    });
  });

  describe('Смена статуса (ТЗ 5.5: Change status с Reason)', () => {
    const body = {
      studentIds: [STUDENT_ID],
      status: GroupStudentStatus.LEFT,
      reason: 'Переехал в другой город',
    };

    beforeEach(() => {
      repository.findMemberships.mockResolvedValue([row()]);
    });

    it('меняет статус с причиной и датой', async () => {
      await service.changeStatus(GROUP_ID, body);

      expect(repository.changeStatus).toHaveBeenCalledWith(
        GROUP_ID,
        [STUDENT_ID],
        GroupStudentStatus.LEFT,
        'Переехал в другой город',
        expect.any(Date),
        MENTOR_ID,
      );
    });

    it('уход фиксирует ментора группы снимком (ТЗ 5.12)', async () => {
      await service.changeStatus(GROUP_ID, body);

      expect(repository.findLeaveMentor).toHaveBeenCalledWith(GROUP_ID);
      expect(repository.changeStatus).toHaveBeenCalledWith(
        GROUP_ID,
        [STUDENT_ID],
        GroupStudentStatus.LEFT,
        expect.any(String),
        expect.any(Date),
        MENTOR_ID,
      );
    });

    it('группа без ведущего ментора уходит в снимок с null, а не с догадкой', async () => {
      repository.findLeaveMentor.mockResolvedValue(null);

      await service.changeStatus(GROUP_ID, body);

      expect(repository.changeStatus).toHaveBeenCalledWith(
        GROUP_ID,
        [STUDENT_ID],
        GroupStudentStatus.LEFT,
        expect.any(String),
        expect.any(Date),
        null,
      );
    });

    it.each([GroupStudentStatus.ACTIVE, GroupStudentStatus.FINISHED])(
      'статус %s снимает снимок ментора и не спрашивает его у группы',
      async (status) => {
        await service.changeStatus(GROUP_ID, { ...body, status });

        expect(repository.findLeaveMentor).not.toHaveBeenCalled();
        expect(repository.changeStatus).toHaveBeenCalledWith(
          GROUP_ID,
          [STUDENT_ID],
          status,
          expect.any(String),
          expect.any(Date),
          null,
        );
      },
    );

    it('отдаёт новый статус и «набрано» после смены', async () => {
      repository.countActive.mockResolvedValue(9);
      repository.changeStatus.mockResolvedValue([
        row({ status: GroupStudentStatus.LEFT, statusReason: 'Переехал в другой город' }),
      ]);

      await expect(service.changeStatus(GROUP_ID, body)).resolves.toMatchObject({
        groupId: GROUP_ID,
        status: GroupStudentStatus.LEFT,
        enrolledCount: 9,
      });
    });

    it('422 на TRANSFERRED — перевод ставится своим маршрутом', async () => {
      await expect(
        service.changeStatus(GROUP_ID, { ...body, status: GroupStudentStatus.TRANSFERRED }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.changeStatus).not.toHaveBeenCalled();
    });

    it('422 на студента не из состава, с перечислением недостающих', async () => {
      repository.findMemberships.mockResolvedValue([]);

      await expect(service.changeStatus(GROUP_ID, body)).rejects.toMatchObject({
        response: { details: { studentIds: [STUDENT_ID] } },
      });
      expect(repository.changeStatus).not.toHaveBeenCalled();
    });

    it('возврат в ACTIVE проверяет правило «одна группа на курс»', async () => {
      repository.findCompetingMemberships.mockResolvedValue([competing()]);

      await expect(
        service.changeStatus(GROUP_ID, { ...body, status: GroupStudentStatus.ACTIVE }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.changeStatus).not.toHaveBeenCalled();
    });

    it('уход из группы это правило не проверяет — лишнего запроса нет', async () => {
      await service.changeStatus(GROUP_ID, body);

      expect(repository.findCompetingMemberships).not.toHaveBeenCalled();
    });

    it('404 на неизвестную группу — до проверки состава', async () => {
      repository.findGroup.mockResolvedValue(null);

      await expect(service.changeStatus(GROUP_ID, body)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findMemberships).not.toHaveBeenCalled();
    });
  });

  describe('Перевод в другую группу (ТЗ 5.5: Transfer)', () => {
    const body = {
      studentIds: [STUDENT_ID],
      targetGroupId: OTHER_GROUP_ID,
      reason: 'Перевод в вечерний поток',
    };

    beforeEach(() => {
      repository.findMemberships.mockResolvedValue([row()]);
      repository.findGroup.mockImplementation((id: string) =>
        Promise.resolve(
          id === GROUP_ID
            ? group()
            : group({ id: OTHER_GROUP_ID, name: 'Frontend-2', courseId: COURSE_ID }),
        ),
      );
    });

    it('переводит студентов и отдаёт обе группы', async () => {
      await expect(service.transfer(GROUP_ID, body)).resolves.toMatchObject({
        fromGroupId: GROUP_ID,
        toGroupId: OTHER_GROUP_ID,
      });

      expect(repository.transfer).toHaveBeenCalledWith({
        fromGroupId: GROUP_ID,
        toGroupId: OTHER_GROUP_ID,
        studentIds: [STUDENT_ID],
        reason: 'Перевод в вечерний поток',
        changedAt: expect.any(Date),
      });
    });

    it('отдаёт, сколько осталось в прежней группе', async () => {
      repository.countActive.mockResolvedValue(8);

      await expect(service.transfer(GROUP_ID, body)).resolves.toMatchObject({ enrolledCount: 8 });
      expect(repository.countActive).toHaveBeenCalledWith(GROUP_ID);
    });

    it('422 на перевод в ту же группу', async () => {
      await expect(
        service.transfer(GROUP_ID, { ...body, targetGroupId: GROUP_ID }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.transfer).not.toHaveBeenCalled();
    });

    it('422 на несуществующую группу назначения (пришла в теле, а не в пути)', async () => {
      repository.findGroup.mockImplementation((id: string) =>
        Promise.resolve(id === GROUP_ID ? group() : null),
      );

      await expect(service.transfer(GROUP_ID, body)).rejects.toMatchObject({
        response: { details: { targetGroupId: OTHER_GROUP_ID } },
      });
      expect(repository.transfer).not.toHaveBeenCalled();
    });

    it('422 на студента не из состава исходной группы', async () => {
      repository.findMemberships.mockResolvedValue([]);

      await expect(service.transfer(GROUP_ID, body)).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.transfer).not.toHaveBeenCalled();
    });

    it('курс проверяется у группы назначения; обе группы перевода в счёт не идут', async () => {
      repository.findGroup.mockImplementation((id: string) =>
        Promise.resolve(
          id === GROUP_ID
            ? group()
            : group({ id: OTHER_GROUP_ID, name: 'Python-1', courseId: 'course-python' }),
        ),
      );

      await service.transfer(GROUP_ID, body);

      expect(repository.findCompetingMemberships).toHaveBeenCalledWith(
        'course-python',
        [STUDENT_ID],
        [GROUP_ID, OTHER_GROUP_ID],
      );
    });

    it('409, если студент уже учится в третьей группе курса назначения', async () => {
      repository.findCompetingMemberships.mockResolvedValue([competing()]);

      await expect(service.transfer(GROUP_ID, body)).rejects.toBeInstanceOf(ConflictException);
      expect(repository.transfer).not.toHaveBeenCalled();
    });

    it('404 на неизвестную исходную группу', async () => {
      repository.findGroup.mockResolvedValue(null);

      await expect(service.transfer(GROUP_ID, body)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('Исключение из состава', () => {
    it('убирает членство и называет убранного', async () => {
      repository.countActive.mockResolvedValue(11);

      await expect(service.remove(GROUP_ID, STUDENT_ID)).resolves.toEqual({
        groupId: GROUP_ID,
        studentId: STUDENT_ID,
        fullName: 'Каримова Нигина',
        enrolledCount: 11,
      });
      expect(repository.delete).toHaveBeenCalledWith(GROUP_ID, STUDENT_ID);
    });

    it('404 на студента не из этой группы', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.remove(GROUP_ID, STUDENT_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('сообщения про группу и про студента различимы', async () => {
      repository.findGroup.mockResolvedValue(null);

      await expect(service.remove(GROUP_ID, STUDENT_ID)).rejects.toMatchObject({
        response: { message: 'Группа не найдена' },
      });

      repository.findGroup.mockResolvedValue(group());
      repository.findOne.mockResolvedValue(null);

      await expect(service.remove(GROUP_ID, STUDENT_ID)).rejects.toMatchObject({
        response: { message: 'Студент не состоит в этой группе' },
      });
    });
  });

  describe('Пересчёт статуса профиля (ТЗ 5.3, решение сессии 0014)', () => {
    /** Ответ на «какие членства у этих студентов сейчас». */
    const withMemberships = (
      ...groups: { status: GroupStudentStatus; statusChangedAt: Date | null }[]
    ): void => {
      repository.findStudentsWithMemberships.mockResolvedValue([
        { id: STUDENT_ID, status: StudentStatus.NO_ACTIVE, groups },
      ]);
    };

    it('зачисление возвращает профиль в ACTIVE', async () => {
      withMemberships(membership(GroupStudentStatus.ACTIVE));

      await service.add(GROUP_ID, { studentIds: [STUDENT_ID] });

      expect(repository.findStudentsWithMemberships).toHaveBeenCalledWith([STUDENT_ID]);
      expect(repository.setStudentStatuses).toHaveBeenCalledWith([
        { studentId: STUDENT_ID, status: StudentStatus.ACTIVE },
      ]);
    });

    it('уход из последней группы переводит профиль в NO_ACTIVE (ТЗ 5.12)', async () => {
      repository.findMemberships.mockResolvedValue([row()]);
      repository.findStudentsWithMemberships.mockResolvedValue([
        {
          id: STUDENT_ID,
          status: StudentStatus.ACTIVE,
          groups: [membership(GroupStudentStatus.LEFT, new Date('2026-06-01T00:00:00.000Z'))],
        },
      ]);

      await service.changeStatus(GROUP_ID, {
        studentIds: [STUDENT_ID],
        status: GroupStudentStatus.LEFT,
        reason: 'Переехал в другой город',
      });

      expect(repository.setStudentStatuses).toHaveBeenCalledWith([
        { studentId: STUDENT_ID, status: StudentStatus.NO_ACTIVE },
      ]);
    });

    it('уход из одной группы не трогает профиль, пока студент учится в другой', async () => {
      repository.findMemberships.mockResolvedValue([row()]);
      repository.findStudentsWithMemberships.mockResolvedValue([
        {
          id: STUDENT_ID,
          status: StudentStatus.ACTIVE,
          groups: [
            membership(GroupStudentStatus.LEFT, new Date('2026-06-01T00:00:00.000Z')),
            membership(GroupStudentStatus.ACTIVE),
          ],
        },
      ]);

      await service.changeStatus(GROUP_ID, {
        studentIds: [STUDENT_ID],
        status: GroupStudentStatus.LEFT,
        reason: 'Переехал в другой город',
      });

      expect(repository.setStudentStatuses).not.toHaveBeenCalled();
    });

    it('завершение курса переводит профиль в FINISHED', async () => {
      repository.findMemberships.mockResolvedValue([row()]);
      repository.findStudentsWithMemberships.mockResolvedValue([
        {
          id: STUDENT_ID,
          status: StudentStatus.ACTIVE,
          groups: [membership(GroupStudentStatus.FINISHED, new Date('2026-06-01T00:00:00.000Z'))],
        },
      ]);

      await service.changeStatus(GROUP_ID, {
        studentIds: [STUDENT_ID],
        status: GroupStudentStatus.FINISHED,
        reason: 'Курс пройден',
      });

      expect(repository.setStudentStatuses).toHaveBeenCalledWith([
        { studentId: STUDENT_ID, status: StudentStatus.FINISHED },
      ]);
    });

    it('BLOCK автоматика не перебивает', async () => {
      repository.findStudentsWithMemberships.mockResolvedValue([
        {
          id: STUDENT_ID,
          status: StudentStatus.BLOCK,
          groups: [membership(GroupStudentStatus.ACTIVE)],
        },
      ]);

      await service.add(GROUP_ID, { studentIds: [STUDENT_ID] });

      expect(repository.setStudentStatuses).not.toHaveBeenCalled();
    });

    it('совпадающий статус в БД не пишется', async () => {
      // Умолчание набора: студент уже `ACTIVE` и учится.
      await service.add(GROUP_ID, { studentIds: [STUDENT_ID] });

      expect(repository.setStudentStatuses).not.toHaveBeenCalled();
    });

    it('перевод пересчитывает переведённых', async () => {
      repository.findMemberships.mockResolvedValue([row()]);
      withMemberships(membership(GroupStudentStatus.ACTIVE));

      await service.transfer(GROUP_ID, {
        studentIds: [STUDENT_ID],
        targetGroupId: OTHER_GROUP_ID,
        reason: 'Перевод в вечерний поток',
      });

      expect(repository.findStudentsWithMemberships).toHaveBeenCalledWith([STUDENT_ID]);
    });

    it('исключение из состава пересчитывает профиль', async () => {
      repository.findStudentsWithMemberships.mockResolvedValue([
        { id: STUDENT_ID, status: StudentStatus.ACTIVE, groups: [] },
      ]);

      await service.remove(GROUP_ID, STUDENT_ID);

      expect(repository.findStudentsWithMemberships).toHaveBeenCalledWith([STUDENT_ID]);
      // Профиль без единого членства правило не трогает: им управляет оператор.
      expect(repository.setStudentStatuses).not.toHaveBeenCalled();
    });

    it('импорт пересчитывает зачисленных', async () => {
      withMemberships(membership(GroupStudentStatus.ACTIVE));

      await service.importCsv(GROUP_ID, { csv: 'Телефон\n+992901234567' });

      expect(repository.setStudentStatuses).toHaveBeenCalledWith([
        { studentId: STUDENT_ID, status: StudentStatus.ACTIVE },
      ]);
    });
  });

  describe('Выгрузка состава в CSV', () => {
    const exportQuery = (overrides: Partial<ExportGroupStudentsQueryDto> = {}) =>
      Object.assign(new ExportGroupStudentsQueryDto(), overrides);

    it('собирает файл с заголовком и строкой на каждое членство', async () => {
      const file = await service.exportCsv(GROUP_ID, exportQuery());
      const records = parseCsv(file.content);

      expect(records[0].values).toEqual([
        'Телефон',
        'Фамилия',
        'Имя',
        'Статус в группе',
        'Причина',
        'Дата смены статуса',
        'Переведён из',
        'Дата зачисления',
        'Статус студента',
      ]);
      expect(records[1].values).toEqual([
        '+992901234567',
        'Каримова',
        'Нигина',
        'Учится',
        '',
        '',
        '',
        '2026-09-01',
        'Активен',
      ]);
      expect(file.rows).toBe(1);
    });

    it('начинается с BOM — иначе Excel читает кириллицу как cp1251', () => {
      return expect(
        service.exportCsv(GROUP_ID, exportQuery()).then((file) => file.content.charCodeAt(0)),
      ).resolves.toBe(0xfeff);
    });

    it('переводит статусы и даты в человекочитаемый вид', async () => {
      repository.findAllForExport.mockResolvedValue([
        row({
          status: GroupStudentStatus.TRANSFERRED,
          statusReason: 'Переехал в другой город',
          statusChangedAt: new Date('2026-10-05T12:00:00.000Z'),
          transferredFromGroup: { id: OTHER_GROUP_ID, name: 'Frontend-2' },
          student: { ...row().student, status: StudentStatus.NO_ACTIVE },
        }),
      ]);

      const records = parseCsv((await service.exportCsv(GROUP_ID, exportQuery())).content);

      expect(records[1].values).toEqual([
        '+992901234567',
        'Каримова',
        'Нигина',
        'Переведён в другую группу',
        'Переехал в другой город',
        '2026-10-05',
        'Frontend-2',
        '2026-09-01',
        'Неактивен',
      ]);
    });

    it('передаёт доменные фильтры в выборку, но не окно страницы', async () => {
      await service.exportCsv(
        GROUP_ID,
        exportQuery({ status: GroupStudentStatus.LEFT, search: 'каримова' }),
      );

      expect(repository.findAllForExport).toHaveBeenCalledWith({
        groupId: GROUP_ID,
        status: GroupStudentStatus.LEFT,
        search: 'каримова',
      });
    });

    it('имя файла содержит название группы, а запасное — только ASCII', async () => {
      const file = await service.exportCsv(GROUP_ID, exportQuery());

      expect(file.fileName).toMatch(/^Состав группы Frontend-1 \d{4}-\d{2}-\d{2}\.csv$/);
      expect(file.asciiFileName).toMatch(/^group-students-\d{4}-\d{2}-\d{2}\.csv$/);
    });

    it('пустой состав даёт файл из одного заголовка, а не ошибку', async () => {
      repository.findAllForExport.mockResolvedValue([]);

      const file = await service.exportCsv(GROUP_ID, exportQuery());

      expect(parseCsv(file.content)).toHaveLength(1);
      expect(file.rows).toBe(0);
    });

    it('404 на неизвестную группу — до запроса состава', async () => {
      repository.findGroup.mockResolvedValue(null);

      await expect(service.exportCsv(GROUP_ID, exportQuery())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.findAllForExport).not.toHaveBeenCalled();
    });
  });

  describe('Импорт состава из CSV', () => {
    it('зачисляет студентов, найденных по телефону', async () => {
      repository.countActive.mockResolvedValue(1);

      const result = await service.importCsv(GROUP_ID, {
        csv: 'Телефон\n+992901234567',
      });

      expect(repository.findStudentsByPhones).toHaveBeenCalledWith(['+992901234567']);
      expect(repository.enroll).toHaveBeenCalledWith(GROUP_ID, [STUDENT_ID], expect.any(Date));
      expect(result).toMatchObject({ groupId: GROUP_ID, imported: 1, enrolledCount: 1 });
    });

    it('нормализует телефон по правилам ТЗ 3.1 — локальный номер находит студента', async () => {
      await service.importCsv(GROUP_ID, { csv: 'phone\n901234567' });

      expect(repository.findStudentsByPhones).toHaveBeenCalledWith(['+992901234567']);
    });

    it('принимает файл собственной выгрузки без правки', async () => {
      const exported = await service.exportCsv(GROUP_ID, new ExportGroupStudentsQueryDto());

      await service.importCsv(GROUP_ID, { csv: exported.content });

      expect(repository.findStudentsByPhones).toHaveBeenCalledWith(['+992901234567']);
    });

    it('колонка телефона ищется по названию, а не по позиции', async () => {
      await service.importCsv(GROUP_ID, {
        csv: 'Фамилия,Имя,Телефон\nКаримова,Нигина,+992901234567',
      });

      expect(repository.findStudentsByPhones).toHaveBeenCalledWith(['+992901234567']);
    });

    it('400, если колонки с телефоном в заголовке нет', async () => {
      await expect(
        service.importCsv(GROUP_ID, { csv: 'Фамилия,Имя\nКаримова,Нигина' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.enroll).not.toHaveBeenCalled();
    });

    it('400 на файл без строк данных', async () => {
      await expect(service.importCsv(GROUP_ID, { csv: 'Телефон' })).rejects.toMatchObject({
        response: { message: 'Файл не содержит ни одной строки с данными' },
      });
    });

    it('400 на слишком длинный файл', async () => {
      const csv = ['Телефон', ...Array.from({ length: 501 }, () => '+992901234567')].join('\n');

      await expect(service.importCsv(GROUP_ID, { csv })).rejects.toMatchObject({
        response: { message: expect.stringContaining('Слишком много строк') },
      });
    });

    it('422 перечисляет все плохие строки с их номерами, ничего не зачисляя', async () => {
      repository.findStudentsByPhones.mockResolvedValue([byPhone()]);

      const csv = [
        'Телефон',
        '+992901234567', // строка 2 — найдётся
        'не телефон', //    строка 3
        '', //               строка 4 — пустая, пропускается разбором
        '+992985550101', //  строка 5 — профиля нет
        '+992901234567', //  строка 6 — повтор строки 2
      ].join('\n');

      await expect(service.importCsv(GROUP_ID, { csv })).rejects.toMatchObject({
        response: {
          details: {
            errors: 3,
            rows: [
              { line: 3, reason: 'Телефон не распознан' },
              { line: 5, reason: 'Студент с таким телефоном не найден' },
              { line: 6, reason: 'Повтор телефона из строки 2' },
            ],
          },
        },
      });
      expect(repository.enroll).not.toHaveBeenCalled();
    });

    it('422 на пустую ячейку телефона', async () => {
      await expect(
        service.importCsv(GROUP_ID, { csv: 'Телефон,Фамилия\n,Каримова' }),
      ).rejects.toMatchObject({
        response: { details: { rows: [{ line: 2, reason: 'Телефон не указан' }] } },
      });
    });

    it('422 на уже учащегося в этой группе — с номером его строки', async () => {
      repository.findMemberships.mockResolvedValue([row()]);

      await expect(
        service.importCsv(GROUP_ID, { csv: 'Телефон\n+992901234567' }),
      ).rejects.toMatchObject({
        response: { details: { rows: [{ line: 2, reason: 'Уже учится в этой группе' }] } },
      });
      expect(repository.enroll).not.toHaveBeenCalled();
    });

    it('покинувший группу импортом зачисляется заново', async () => {
      repository.findMemberships.mockResolvedValue([row({ status: GroupStudentStatus.LEFT })]);

      await service.importCsv(GROUP_ID, { csv: 'Телефон\n+992901234567' });

      expect(repository.enroll).toHaveBeenCalledWith(GROUP_ID, [STUDENT_ID], expect.any(Date));
    });

    it('422 на студента из другой группы того же курса — с названием группы', async () => {
      repository.findCompetingMemberships.mockResolvedValue([competing()]);

      await expect(
        service.importCsv(GROUP_ID, { csv: 'Телефон\n+992901234567' }),
      ).rejects.toMatchObject({
        response: {
          details: {
            rows: [{ line: 2, reason: 'Уже учится в другой группе этого курса: Frontend-2' }],
          },
        },
      });
      expect(repository.findCompetingMemberships).toHaveBeenCalledWith(
        COURSE_ID,
        [STUDENT_ID],
        [GROUP_ID],
      );
    });

    it('в ответе перечисляется не больше 50 строк, но их общее число названо', async () => {
      repository.findStudentsByPhones.mockResolvedValue([]);
      const csv = [
        'Телефон',
        ...Array.from({ length: 60 }, (_, index) => `+99290123${String(4000 + index)}`),
      ].join('\n');

      await expect(service.importCsv(GROUP_ID, { csv })).rejects.toMatchObject({
        response: { details: { errors: 60 } },
      });

      const error = await service.importCsv(GROUP_ID, { csv }).catch((cause: unknown) => cause);
      const details = (error as { response: { details: { rows: unknown[] } } }).response.details;

      expect(details.rows).toHaveLength(50);
    });

    it('404 на неизвестную группу — до разбора файла', async () => {
      repository.findGroup.mockResolvedValue(null);

      await expect(
        service.importCsv(GROUP_ID, { csv: 'Телефон\n+992901234567' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findStudentsByPhones).not.toHaveBeenCalled();
    });
  });
});
