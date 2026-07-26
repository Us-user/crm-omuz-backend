import { ConflictException, NotFoundException } from '@nestjs/common';
import { GroupStudentStatus, StudentStatus } from '@prisma/client';

import { BusinessRuleException, SortOrder } from '../common';
import { GroupStudentQueryDto, GroupStudentSortField } from './dto';
import type {
  CompetingMembership,
  GroupStudentRow,
  GroupStudentsRepository,
  StudentCandidate,
  StudentGroup,
} from './group-students.repository';
import { GroupStudentsService } from './group-students.service';

const GROUP_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_GROUP_ID = '22222222-2222-2222-2222-222222222222';
const COURSE_ID = '33333333-3333-3333-3333-333333333333';
const STUDENT_ID = '44444444-4444-4444-4444-444444444444';
const SECOND_STUDENT_ID = '55555555-5555-5555-5555-555555555555';

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
      | 'findGroup'
      | 'findStudents'
      | 'findOne'
      | 'findMemberships'
      | 'findCompetingMemberships'
      | 'countActive'
      | 'enroll'
      | 'changeStatus'
      | 'transfer'
      | 'delete'
    >
  >;
  let service: GroupStudentsService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findGroup: jest.fn().mockResolvedValue(group()),
      findStudents: jest.fn().mockResolvedValue([candidate()]),
      findOne: jest.fn().mockResolvedValue(row()),
      findMemberships: jest.fn().mockResolvedValue([]),
      findCompetingMemberships: jest.fn().mockResolvedValue([]),
      countActive: jest.fn().mockResolvedValue(1),
      enroll: jest.fn().mockResolvedValue([row()]),
      changeStatus: jest.fn().mockResolvedValue([row()]),
      transfer: jest.fn().mockResolvedValue([row({ groupId: OTHER_GROUP_ID })]),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    service = new GroupStudentsService(repository as unknown as GroupStudentsRepository);
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
      );
    });

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
});
