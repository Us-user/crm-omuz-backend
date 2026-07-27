import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  Gender,
  GroupFormat,
  GroupMentorRole,
  GroupStatus,
  GroupStudentStatus,
  ParentRelation,
  StudentStatus,
  WeekDay,
} from '@prisma/client';

import { BusinessRuleException, SortOrder } from '../common';
import { MeGroupQueryDto, MeGroupSortField, MeScheduleQueryDto, MeScheduleSortField } from './dto';
import type {
  MeMembershipRow,
  MeProfileRow,
  MeSlotRow,
  StudentCabinetRepository,
} from './student-cabinet.repository';
import { StudentCabinetService } from './student-cabinet.service';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const STUDENT_ID = '22222222-2222-2222-2222-222222222222';
const GROUP_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_GROUP_ID = '44444444-4444-4444-4444-444444444444';
const COURSE_ID = '55555555-5555-5555-5555-555555555555';
const BRANCH_ID = '66666666-6666-6666-6666-666666666666';
const MENTOR_ID = '77777777-7777-7777-7777-777777777777';
const PARENT_ID = '88888888-8888-8888-8888-888888888888';
const ROOM_ID = '99999999-9999-9999-9999-999999999999';
const SLOT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const profile = (overrides: Partial<MeProfileRow> = {}): MeProfileRow => ({
  id: STUDENT_ID,
  firstName: 'Нигина',
  lastName: 'Каримова',
  phone: '+992901234567',
  birthDate: new Date('2004-05-17T00:00:00.000Z'),
  gender: Gender.FEMALE,
  address: 'Душанбе, ул. Рудаки, 12',
  email: 'nigina@mail.tj',
  extraPhones: ['+992921112233'],
  telegram: '@nigina',
  photoUrl: 'https://cdn.omuz.tj/students/nigina.jpg',
  status: StudentStatus.ACTIVE,
  createdAt: new Date('2026-07-27T10:15:00.000Z'),
  branch: { id: BRANCH_ID, name: 'Sadbarg' },
  parents: [
    {
      relation: ParentRelation.MOTHER,
      parent: {
        id: PARENT_ID,
        firstName: 'Гулнора',
        lastName: 'Каримова',
        phone: '+992907654321',
      },
    },
  ],
  ...overrides,
});

const membership = (overrides: Partial<MeMembershipRow> = {}): MeMembershipRow => ({
  status: GroupStudentStatus.ACTIVE,
  statusReason: null,
  statusChangedAt: null,
  enrolledAt: new Date('2026-09-01T10:15:00.000Z'),
  group: {
    id: GROUP_ID,
    name: 'Frontend-1',
    format: GroupFormat.OFFLINE,
    status: GroupStatus.ACTIVE,
    startDate: new Date('2026-09-01T00:00:00.000Z'),
    endDate: new Date('2026-11-30T00:00:00.000Z'),
    telegramUrl: 'https://t.me/omuz_frontend_1',
    course: { id: COURSE_ID, title: 'Frontend Basic', subtitle: 'HTML, CSS, JavaScript' },
    branch: { id: BRANCH_ID, name: 'Sadbarg' },
    mentors: [
      {
        role: GroupMentorRole.TEACHING,
        employee: {
          id: MENTOR_ID,
          firstName: 'Фаррух',
          lastName: 'Раҳимов',
          middleName: 'Саидович',
        },
      },
    ],
  },
  ...overrides,
});

const slot = (overrides: Partial<MeSlotRow> = {}): MeSlotRow => ({
  id: SLOT_ID,
  dayOfWeek: WeekDay.MONDAY,
  startMinute: 600,
  endMinute: 720,
  group: { id: GROUP_ID, name: 'Frontend-1', course: { id: COURSE_ID, title: 'Frontend Basic' } },
  room: { id: ROOM_ID, name: '101' },
  mentor: { id: MENTOR_ID, firstName: 'Фаррух', lastName: 'Раҳимов', middleName: 'Саидович' },
  ...overrides,
});

// Настоящие экземпляры DTO, а не литералы: `skip`/`take` — вычисляемые геттеры.
const groupQuery = (overrides: Partial<MeGroupQueryDto> = {}): MeGroupQueryDto =>
  Object.assign(new MeGroupQueryDto(), overrides);

const scheduleQuery = (overrides: Partial<MeScheduleQueryDto> = {}): MeScheduleQueryDto =>
  Object.assign(new MeScheduleQueryDto(), overrides);

describe('StudentCabinetService', () => {
  let repository: jest.Mocked<
    Pick<
      StudentCabinetRepository,
      'findByAccountId' | 'findMemberships' | 'findSchedule' | 'findActiveMembership'
    >
  >;
  let service: StudentCabinetService;

  beforeEach(() => {
    repository = {
      findByAccountId: jest.fn().mockResolvedValue(profile()),
      findMemberships: jest.fn().mockResolvedValue({ rows: [membership()], total: 1 }),
      findSchedule: jest.fn().mockResolvedValue({ rows: [slot()], total: 1 }),
      findActiveMembership: jest.fn().mockResolvedValue({ groupId: GROUP_ID }),
    };

    service = new StudentCabinetService(repository as unknown as StudentCabinetRepository);
  });

  describe('Профиль (ТЗ 5.3: «свой профиль»)', () => {
    it('отдаёт профиль вызывающего, найденный по аккаунту из токена', async () => {
      const result = await service.profile(ACCOUNT_ID);

      expect(repository.findByAccountId).toHaveBeenCalledWith(ACCOUNT_ID);
      expect(result).toMatchObject({
        id: STUDENT_ID,
        firstName: 'Нигина',
        lastName: 'Каримова',
        phone: '+992901234567',
        status: StudentStatus.ACTIVE,
        branch: { id: BRANCH_ID, name: 'Sadbarg' },
      });
    });

    it('дата рождения — YYYY-MM-DD, без времени', async () => {
      expect((await service.profile(ACCOUNT_ID)).birthDate).toBe('2004-05-17');
    });

    it('незаполненные поля отдаются как null, а доп. телефоны — списком', async () => {
      repository.findByAccountId.mockResolvedValue(
        profile({ birthDate: null, address: null, email: null, branch: null, extraPhones: [] }),
      );

      expect(await service.profile(ACCOUNT_ID)).toMatchObject({
        birthDate: null,
        address: null,
        email: null,
        branch: null,
        extraPhones: [],
      });
    });

    it('родители отдаются контактами со степенью родства (ТЗ 4)', async () => {
      expect((await service.profile(ACCOUNT_ID)).parents).toEqual([
        {
          id: PARENT_ID,
          firstName: 'Гулнора',
          lastName: 'Каримова',
          phone: '+992907654321',
          relation: ParentRelation.MOTHER,
        },
      ]);
    });

    it('заметок администратора и данных аккаунта в профиле нет', async () => {
      const result = await service.profile(ACCOUNT_ID);

      expect(result).not.toHaveProperty('notes');
      expect(result).not.toHaveProperty('account');
      expect(result).not.toHaveProperty('groupsCount');
    });

    it('404, если у аккаунта нет профиля студента', async () => {
      repository.findByAccountId.mockResolvedValue(null);

      await expect(service.profile(ACCOUNT_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('403 заблокированному: блокировка — это закрытие входа (ТЗ 5.3)', async () => {
      repository.findByAccountId.mockResolvedValue(profile({ status: StudentStatus.BLOCK }));

      await expect(service.profile(ACCOUNT_ID)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('статусы, кроме BLOCK, кабинет не закрывают', async () => {
      repository.findByAccountId.mockResolvedValue(profile({ status: StudentStatus.NO_ACTIVE }));

      expect((await service.profile(ACCOUNT_ID)).status).toBe(StudentStatus.NO_ACTIVE);
    });
  });

  describe('Свои группы (ТЗ 5.3: «свои группы»)', () => {
    it('отдаёт членство с курсом, филиалом и менторами', async () => {
      const result = await service.groups(ACCOUNT_ID, groupQuery());

      expect(result.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(result.items[0]).toMatchObject({
        id: GROUP_ID,
        name: 'Frontend-1',
        course: { id: COURSE_ID, title: 'Frontend Basic' },
        branch: { id: BRANCH_ID, name: 'Sadbarg' },
        format: GroupFormat.OFFLINE,
        groupStatus: GroupStatus.ACTIVE,
        status: GroupStudentStatus.ACTIVE,
        mentors: [
          {
            id: MENTOR_ID,
            firstName: 'Фаррух',
            lastName: 'Раҳимов',
            middleName: 'Саидович',
            role: GroupMentorRole.TEACHING,
          },
        ],
      });
    });

    it('сроки группы — YYYY-MM-DD, без времени', async () => {
      expect(await service.groups(ACCOUNT_ID, groupQuery())).toMatchObject({
        items: [{ startDate: '2026-09-01', endDate: '2026-11-30' }],
      });
    });

    it('закрытое членство отдаётся с причиной и датой смены статуса', async () => {
      repository.findMemberships.mockResolvedValue({
        rows: [
          membership({
            status: GroupStudentStatus.LEFT,
            statusReason: 'Переехал в другой город',
            statusChangedAt: new Date('2026-10-15T08:30:00.000Z'),
          }),
        ],
        total: 1,
      });

      expect((await service.groups(ACCOUNT_ID, groupQuery())).items[0]).toMatchObject({
        status: GroupStudentStatus.LEFT,
        statusReason: 'Переехал в другой город',
        statusChangedAt: '2026-10-15T08:30:00.000Z',
      });
    });

    it('по умолчанию — свежие сверху, по дате зачисления', async () => {
      await service.groups(ACCOUNT_ID, groupQuery());

      expect(repository.findMemberships).toHaveBeenCalledWith(
        expect.objectContaining({ sort: MeGroupSortField.EnrolledAt, order: SortOrder.Desc }),
      );
    });

    it('передаёт окно страницы, фильтр статуса и поиск, подставляя свой профиль', async () => {
      await service.groups(
        ACCOUNT_ID,
        groupQuery({
          page: 2,
          limit: 5,
          search: 'Frontend',
          status: GroupStudentStatus.ACTIVE,
          sort: MeGroupSortField.Name,
          order: SortOrder.Asc,
        }),
      );

      expect(repository.findMemberships).toHaveBeenCalledWith({
        studentId: STUDENT_ID,
        search: 'Frontend',
        status: GroupStudentStatus.ACTIVE,
        sort: MeGroupSortField.Name,
        order: SortOrder.Asc,
        skip: 5,
        take: 5,
      });
    });

    it('403 заблокированному — до запроса групп', async () => {
      repository.findByAccountId.mockResolvedValue(profile({ status: StudentStatus.BLOCK }));

      await expect(service.groups(ACCOUNT_ID, groupQuery())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(repository.findMemberships).not.toHaveBeenCalled();
    });

    it('404 без профиля — до запроса групп', async () => {
      repository.findByAccountId.mockResolvedValue(null);

      await expect(service.groups(ACCOUNT_ID, groupQuery())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.findMemberships).not.toHaveBeenCalled();
    });
  });

  describe('Своё расписание (ТЗ 5.3: «расписание»)', () => {
    it('отдаёт занятие с группой, аудиторией и ментором, время — HH:MM', async () => {
      const result = await service.schedule(ACCOUNT_ID, scheduleQuery());

      expect(result.meta).toMatchObject({ total: 1 });
      expect(result.items[0]).toEqual({
        id: SLOT_ID,
        group: {
          id: GROUP_ID,
          name: 'Frontend-1',
          courseId: COURSE_ID,
          courseTitle: 'Frontend Basic',
        },
        dayOfWeek: WeekDay.MONDAY,
        startTime: '10:00',
        endTime: '12:00',
        room: { id: ROOM_ID, name: '101' },
        mentor: {
          id: MENTOR_ID,
          firstName: 'Фаррух',
          lastName: 'Раҳимов',
          middleName: 'Саидович',
        },
      });
    });

    it('занятие онлайн отдаётся без аудитории и без ментора', async () => {
      repository.findSchedule.mockResolvedValue({
        rows: [slot({ room: null, mentor: null })],
        total: 1,
      });

      expect((await service.schedule(ACCOUNT_ID, scheduleQuery())).items[0]).toMatchObject({
        room: null,
        mentor: null,
      });
    });

    it('по умолчанию — с начала недели: день недели, затем время', async () => {
      await service.schedule(ACCOUNT_ID, scheduleQuery());

      expect(repository.findSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ sort: MeScheduleSortField.DayOfWeek, order: SortOrder.Asc }),
      );
    });

    it('передаёт окно страницы, день недели и поиск, подставляя свой профиль', async () => {
      await service.schedule(
        ACCOUNT_ID,
        scheduleQuery({
          page: 3,
          limit: 10,
          search: '101',
          dayOfWeek: WeekDay.TUESDAY,
          sort: MeScheduleSortField.StartTime,
          order: SortOrder.Desc,
        }),
      );

      expect(repository.findSchedule).toHaveBeenCalledWith({
        studentId: STUDENT_ID,
        search: '101',
        groupId: undefined,
        dayOfWeek: WeekDay.TUESDAY,
        sort: MeScheduleSortField.StartTime,
        order: SortOrder.Desc,
        skip: 20,
        take: 10,
      });
    });

    it('фильтр по своей действующей группе проверяется и доходит до выборки', async () => {
      await service.schedule(ACCOUNT_ID, scheduleQuery({ groupId: GROUP_ID }));

      expect(repository.findActiveMembership).toHaveBeenCalledWith(STUDENT_ID, GROUP_ID);
      expect(repository.findSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ groupId: GROUP_ID }),
      );
    });

    it('422 на чужую группу в фильтре — расписание не запрашивается', async () => {
      repository.findActiveMembership.mockResolvedValue(null);

      await expect(
        service.schedule(ACCOUNT_ID, scheduleQuery({ groupId: OTHER_GROUP_ID })),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.findSchedule).not.toHaveBeenCalled();
    });

    it('без фильтра принадлежность группы не проверяется лишним запросом', async () => {
      await service.schedule(ACCOUNT_ID, scheduleQuery());

      expect(repository.findActiveMembership).not.toHaveBeenCalled();
    });

    it('403 заблокированному — до проверки группы и выборки', async () => {
      repository.findByAccountId.mockResolvedValue(profile({ status: StudentStatus.BLOCK }));

      await expect(
        service.schedule(ACCOUNT_ID, scheduleQuery({ groupId: GROUP_ID })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.findActiveMembership).not.toHaveBeenCalled();
      expect(repository.findSchedule).not.toHaveBeenCalled();
    });

    it('404 без профиля — до выборки', async () => {
      repository.findByAccountId.mockResolvedValue(null);

      await expect(service.schedule(ACCOUNT_ID, scheduleQuery())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.findSchedule).not.toHaveBeenCalled();
    });
  });
});
