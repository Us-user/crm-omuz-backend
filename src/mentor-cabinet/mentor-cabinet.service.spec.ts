import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  DirectoryStatus,
  DurationUnit,
  EmployeeStatus,
  Gender,
  GroupFormat,
  GroupMentorRole,
  GroupStatus,
  LessonType,
  Prisma,
  ResourceFileType,
  ResourceKind,
  WeekDay,
} from '@prisma/client';

import type { AvansService } from '../avans/avans.service';
import { AvansQueryDto } from '../avans/dto';
import { BusinessRuleException, SortOrder } from '../common';
import {
  MentorCourseQueryDto,
  MentorGroupQueryDto,
  MentorGroupSortField,
  MentorMaterialQueryDto,
  MentorMaterialSortField,
  MentorTimetableQueryDto,
  MentorTimetableSortField,
} from './dto';
import type {
  MentorCabinetRepository,
  MentorCourseRow,
  MentorGroupRow,
  MentorLessonRow,
  MentorLevelOfMonthRow,
  MentorProfileRow,
  MentorSlotRow,
} from './mentor-cabinet.repository';
import { MentorCabinetService } from './mentor-cabinet.service';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const EMPLOYEE_ID = '22222222-2222-2222-2222-222222222222';
const GROUP_ID = '33333333-3333-3333-3333-333333333333';
const COURSE_ID = '44444444-4444-4444-4444-444444444444';
const LESSON_ID = '55555555-5555-5555-5555-555555555555';
const OTHER_ID = '66666666-6666-6666-6666-666666666666';
const AVANS_ID = '77777777-7777-7777-7777-777777777777';

const profileRow = (overrides: Partial<MentorProfileRow> = {}): MentorProfileRow => ({
  id: EMPLOYEE_ID,
  firstName: 'Фаррух',
  lastName: 'Раҳимов',
  middleName: 'Азизович',
  phone: '+992901234567',
  birthDate: new Date('1992-03-14T00:00:00.000Z'),
  gender: Gender.MALE,
  address: 'Душанбе, ул. Рудаки, 15',
  email: 'farrukh@omuz.tj',
  telegram: '@farrukh',
  photoUrl: null,
  experience: '5 лет коммерческой разработки',
  description: null,
  status: EmployeeStatus.ACTIVE,
  hiredAt: new Date('2024-09-01T00:00:00.000Z'),
  createdAt: new Date('2024-08-20T10:00:00.000Z'),
  branch: { id: 'branch-1', name: 'Sadbarg' },
  positions: [{ position: { id: 'position-1', name: 'Mentor' } }],
  ...overrides,
});

const levelRow = (overrides: Partial<MentorLevelOfMonthRow> = {}): MentorLevelOfMonthRow => ({
  month: new Date('2026-07-01T00:00:00.000Z'),
  level: {
    id: 'level-1',
    name: 'Senior mentor',
    hourlyRate: new Prisma.Decimal('45.50'),
    status: DirectoryStatus.ACTIVE,
  },
  ...overrides,
});

const groupRow = (overrides: Partial<MentorGroupRow> = {}): MentorGroupRow => ({
  role: GroupMentorRole.TEACHING,
  assignedAt: new Date('2026-08-20T09:00:00.000Z'),
  group: {
    id: GROUP_ID,
    name: 'Frontend-1',
    description: null,
    format: GroupFormat.OFFLINE,
    status: GroupStatus.ACTIVE,
    startDate: new Date('2026-09-01T00:00:00.000Z'),
    endDate: null,
    capacity: 16,
    telegramUrl: null,
    course: { id: COURSE_ID, title: 'Frontend', subtitle: 'React и TypeScript' },
    branch: { id: 'branch-1', name: 'Sadbarg' },
    _count: { students: 12 },
  },
  ...overrides,
});

const slotRow = (overrides: Partial<MentorSlotRow> = {}): MentorSlotRow => ({
  id: 'slot-1',
  dayOfWeek: WeekDay.MONDAY,
  startMinute: 600,
  endMinute: 720,
  mentorId: EMPLOYEE_ID,
  group: { id: GROUP_ID, name: 'Frontend-1', course: { id: COURSE_ID, title: 'Frontend' } },
  room: { id: 'room-1', name: '101' },
  mentor: {
    id: EMPLOYEE_ID,
    firstName: 'Фаррух',
    lastName: 'Раҳимов',
    middleName: 'Азизович',
  },
  ...overrides,
});

const courseRow = (overrides: Partial<MentorCourseRow> = {}): MentorCourseRow => ({
  id: COURSE_ID,
  title: 'Frontend',
  subtitle: 'React и TypeScript',
  description: null,
  colorPrimary: '#1E88E5',
  colorSecondary: null,
  logoUrl: null,
  durationValue: 3,
  durationUnit: DurationUnit.MONTH,
  isLastCourse: false,
  status: DirectoryStatus.ACTIVE,
  createdAt: new Date('2026-01-10T10:00:00.000Z'),
  ...overrides,
});

const lessonRow = (overrides: Partial<MentorLessonRow> = {}): MentorLessonRow => ({
  id: LESSON_ID,
  courseId: COURSE_ID,
  dayNumber: 1,
  title: 'Введение в React',
  description: 'Компоненты и пропсы',
  type: LessonType.LECTURE,
  status: DirectoryStatus.ACTIVE,
  createdAt: new Date('2026-02-01T10:00:00.000Z'),
  course: { id: COURSE_ID, title: 'Frontend' },
  files: [
    {
      id: 'file-1',
      title: 'Слайды по хукам',
      kind: ResourceKind.LECTURE,
      fileType: ResourceFileType.SLIDES,
      url: 'https://drive.google.com/file/d/1abc/view',
      description: null,
    },
  ],
  ...overrides,
});

const groupQuery = (overrides: Partial<MentorGroupQueryDto> = {}): MentorGroupQueryDto =>
  Object.assign(new MentorGroupQueryDto(), overrides);
const timetableQuery = (
  overrides: Partial<MentorTimetableQueryDto> = {},
): MentorTimetableQueryDto => Object.assign(new MentorTimetableQueryDto(), overrides);
const courseQuery = (overrides: Partial<MentorCourseQueryDto> = {}): MentorCourseQueryDto =>
  Object.assign(new MentorCourseQueryDto(), overrides);
const materialQuery = (overrides: Partial<MentorMaterialQueryDto> = {}): MentorMaterialQueryDto =>
  Object.assign(new MentorMaterialQueryDto(), overrides);
const avansQuery = (overrides: Partial<AvansQueryDto> = {}): AvansQueryDto =>
  Object.assign(new AvansQueryDto(), overrides);

describe('MentorCabinetService', () => {
  let repository: jest.Mocked<
    Pick<
      MentorCabinetRepository,
      | 'findByAccountId'
      | 'findLevelOfMonth'
      | 'findGroups'
      | 'findTimetable'
      | 'findCourses'
      | 'findGroupsOfCourses'
      | 'findMaterials'
      | 'findGroupsOfLessons'
      | 'findAssignment'
    >
  >;
  let avans: jest.Mocked<Pick<AvansService, 'findAll' | 'create' | 'remove'>>;
  let service: MentorCabinetService;

  beforeEach(() => {
    repository = {
      findByAccountId: jest.fn().mockResolvedValue(profileRow()),
      findLevelOfMonth: jest.fn().mockResolvedValue(levelRow()),
      findGroups: jest.fn().mockResolvedValue({ rows: [groupRow()], total: 1 }),
      findTimetable: jest.fn().mockResolvedValue({ rows: [slotRow()], total: 1 }),
      findCourses: jest.fn().mockResolvedValue({ rows: [courseRow()], total: 1 }),
      findGroupsOfCourses: jest
        .fn()
        .mockResolvedValue([{ id: GROUP_ID, name: 'Frontend-1', courseId: COURSE_ID }]),
      findMaterials: jest.fn().mockResolvedValue({ rows: [lessonRow()], total: 1 }),
      findGroupsOfLessons: jest
        .fn()
        .mockResolvedValue([{ id: GROUP_ID, name: 'Frontend-1', lessonId: LESSON_ID }]),
      findAssignment: jest.fn().mockResolvedValue({ groupId: GROUP_ID }),
    };

    avans = {
      findAll: jest.fn().mockResolvedValue({ items: [], meta: {} }),
      create: jest.fn().mockResolvedValue({ id: AVANS_ID }),
      remove: jest.fn().mockResolvedValue({ id: AVANS_ID }),
    };

    service = new MentorCabinetService(
      repository as unknown as MentorCabinetRepository,
      avans as unknown as AvansService,
    );
  });

  // ────────────────────────────── Профиль ──────────────────────────────

  describe('Свой профиль (ТЗ 5.4, раздел «Profile»)', () => {
    it('находит профиль по аккаунту из токена, а не по идентификатору из запроса', async () => {
      const profile = await service.profile(ACCOUNT_ID);

      expect(repository.findByAccountId).toHaveBeenCalledWith(ACCOUNT_ID);
      expect(profile.id).toBe(EMPLOYEE_ID);
    });

    it('отдаёт даты рождения и приёма как YYYY-MM-DD', async () => {
      const profile = await service.profile(ACCOUNT_ID);

      expect(profile.birthDate).toBe('1992-03-14');
      expect(profile.hiredAt).toBe('2024-09-01');
    });

    it('незаполненные поля отдаёт как null, а не undefined', async () => {
      repository.findByAccountId.mockResolvedValue(
        profileRow({ middleName: null, birthDate: null, hiredAt: null, branch: null }),
      );

      const profile = await service.profile(ACCOUNT_ID);

      expect(profile).toMatchObject({
        middleName: null,
        birthDate: null,
        hiredAt: null,
        branch: null,
      });
    });

    it('отдаёт уровень и часовую ставку с явно названным месяцем', async () => {
      const profile = await service.profile(ACCOUNT_ID);

      expect(profile.level).toEqual({
        month: '2026-07',
        id: 'level-1',
        name: 'Senior mentor',
        hourlyRate: 45.5,
        status: DirectoryStatus.ACTIVE,
      });
    });

    it('ставка отдаётся числом, а не Decimal — копейки не теряются', async () => {
      const profile = await service.profile(ACCOUNT_ID);

      expect(typeof profile.level?.hourlyRate).toBe('number');
    });

    it('спрашивает уровень на первое число текущего месяца', async () => {
      await service.profile(ACCOUNT_ID);

      const [, month] = repository.findLevelOfMonth.mock.calls[0] ?? [];
      const now = new Date();

      expect(month).toEqual(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
    });

    it('месяц без записи означает отсутствие уровня: предыдущий не тянется', async () => {
      repository.findLevelOfMonth.mockResolvedValue(null);

      const profile = await service.profile(ACCOUNT_ID);

      expect(profile.level).toBeNull();
    });

    it('в профиле нет данных аккаунта', async () => {
      const profile = await service.profile(ACCOUNT_ID);

      expect(Object.keys(profile)).not.toContain('account');
      expect(JSON.stringify(profile)).not.toContain('passwordHash');
    });

    it('404 аккаунту сотрудника без профиля', async () => {
      repository.findByAccountId.mockResolvedValue(null);

      await expect(service.profile(ACCOUNT_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findLevelOfMonth).not.toHaveBeenCalled();
    });

    it('403 выведенному из штата — до запроса уровня', async () => {
      repository.findByAccountId.mockResolvedValue(profileRow({ status: EmployeeStatus.INACTIVE }));

      await expect(service.profile(ACCOUNT_ID)).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.findLevelOfMonth).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────── Группы ───────────────────────────────

  describe('Свои группы (ТЗ 5.4, раздел «Groups»)', () => {
    it('отдаёт группу с курсом, филиалом, своей ролью и «набрано»', async () => {
      const result = await service.groups(ACCOUNT_ID, groupQuery());

      expect(result.items[0]).toMatchObject({
        id: GROUP_ID,
        name: 'Frontend-1',
        course: { id: COURSE_ID, title: 'Frontend' },
        branch: { id: 'branch-1', name: 'Sadbarg' },
        role: GroupMentorRole.TEACHING,
        capacity: 16,
        enrolledCount: 12,
      });
    });

    it('сроки группы отдаёт календарными датами без времени', async () => {
      const result = await service.groups(ACCOUNT_ID, groupQuery());

      expect(result.items[0]).toMatchObject({ startDate: '2026-09-01', endDate: null });
    });

    it('подставляет свой employeeId, фильтры и окно страницы', async () => {
      await service.groups(
        ACCOUNT_ID,
        groupQuery({
          role: GroupMentorRole.SUPPORT,
          status: GroupStatus.ACTIVE,
          search: 'front',
          page: 2,
          limit: 10,
        }),
      );

      expect(repository.findGroups).toHaveBeenCalledWith(
        expect.objectContaining({
          employeeId: EMPLOYEE_ID,
          role: GroupMentorRole.SUPPORT,
          status: GroupStatus.ACTIVE,
          search: 'front',
          skip: 10,
          take: 10,
        }),
      );
    });

    it('по умолчанию отдаёт свежие назначения сверху', async () => {
      await service.groups(ACCOUNT_ID, groupQuery());

      expect(repository.findGroups).toHaveBeenCalledWith(
        expect.objectContaining({
          sort: MentorGroupSortField.AssignedAt,
          order: SortOrder.Desc,
        }),
      );
    });

    it('403 выведенному из штата — до запроса групп', async () => {
      repository.findByAccountId.mockResolvedValue(profileRow({ status: EmployeeStatus.INACTIVE }));

      await expect(service.groups(ACCOUNT_ID, groupQuery())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(repository.findGroups).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────── Расписание ─────────────────────────────

  describe('Своё расписание (ТЗ 5.4, раздел «Timetable»)', () => {
    it('отдаёт время как HH:MM и помечает своё занятие', async () => {
      const result = await service.timetable(ACCOUNT_ID, timetableQuery());

      expect(result.items[0]).toMatchObject({
        startTime: '10:00',
        endTime: '12:00',
        dayOfWeek: WeekDay.MONDAY,
        mine: true,
      });
    });

    it('занятие моей группы, назначенное коллеге, отдаётся с mine = false', async () => {
      repository.findTimetable.mockResolvedValue({
        rows: [
          slotRow({
            mentorId: OTHER_ID,
            mentor: {
              id: OTHER_ID,
              firstName: 'Нигина',
              lastName: 'Каримова',
              middleName: null,
            },
          }),
        ],
        total: 1,
      });

      const result = await service.timetable(ACCOUNT_ID, timetableQuery());

      expect(result.items[0]?.mine).toBe(false);
      expect(result.items[0]?.mentor).toMatchObject({ id: OTHER_ID });
    });

    it('занятие без назначенного ведущего остаётся в расписании с mine = false', async () => {
      repository.findTimetable.mockResolvedValue({
        rows: [slotRow({ mentorId: null, mentor: null, room: null })],
        total: 1,
      });

      const result = await service.timetable(ACCOUNT_ID, timetableQuery());

      expect(result.items[0]).toMatchObject({ mine: false, mentor: null, room: null });
    });

    it('передаёт фильтры, onlyMine и окно страницы', async () => {
      await service.timetable(
        ACCOUNT_ID,
        timetableQuery({ dayOfWeek: WeekDay.FRIDAY, onlyMine: true, page: 3, limit: 5 }),
      );

      expect(repository.findTimetable).toHaveBeenCalledWith(
        expect.objectContaining({
          employeeId: EMPLOYEE_ID,
          dayOfWeek: WeekDay.FRIDAY,
          onlyMine: true,
          skip: 10,
          take: 5,
        }),
      );
    });

    it('по умолчанию читается с начала недели', async () => {
      await service.timetable(ACCOUNT_ID, timetableQuery());

      expect(repository.findTimetable).toHaveBeenCalledWith(
        expect.objectContaining({
          sort: MentorTimetableSortField.DayOfWeek,
          order: SortOrder.Asc,
        }),
      );
    });

    it('фильтр по своей группе проходит проверку менторства', async () => {
      await service.timetable(ACCOUNT_ID, timetableQuery({ groupId: GROUP_ID }));

      expect(repository.findAssignment).toHaveBeenCalledWith(EMPLOYEE_ID, GROUP_ID);
    });

    it('422 на чужую группу в фильтре — расписание не запрашивается', async () => {
      repository.findAssignment.mockResolvedValue(null);

      await expect(
        service.timetable(ACCOUNT_ID, timetableQuery({ groupId: OTHER_ID })),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.findTimetable).not.toHaveBeenCalled();
    });

    it('без фильтра по группе лишнего запроса нет', async () => {
      await service.timetable(ACCOUNT_ID, timetableQuery());

      expect(repository.findAssignment).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────── Курсы ───────────────────────────────

  describe('Свои курсы (ТЗ 5.4, раздел «Courses»)', () => {
    it('отдаёт курс вместе со своими группами этого курса', async () => {
      const result = await service.courses(ACCOUNT_ID, courseQuery());

      expect(result.items[0]).toMatchObject({
        id: COURSE_ID,
        title: 'Frontend',
        groups: [{ id: GROUP_ID, name: 'Frontend-1' }],
      });
    });

    it('группы соседнего курса в строку не попадают', async () => {
      repository.findGroupsOfCourses.mockResolvedValue([
        { id: GROUP_ID, name: 'Frontend-1', courseId: COURSE_ID },
        { id: OTHER_ID, name: 'Python-1', courseId: 'another-course' },
      ]);

      const result = await service.courses(ACCOUNT_ID, courseQuery());

      expect(result.items[0]?.groups).toEqual([{ id: GROUP_ID, name: 'Frontend-1' }]);
    });

    it('группы спрашиваются одним запросом по курсам страницы', async () => {
      await service.courses(ACCOUNT_ID, courseQuery());

      expect(repository.findGroupsOfCourses).toHaveBeenCalledTimes(1);
      expect(repository.findGroupsOfCourses).toHaveBeenCalledWith(EMPLOYEE_ID, [COURSE_ID]);
    });

    it('в курсе нет стоимости: цена — данные бухгалтерии', async () => {
      const result = await service.courses(ACCOUNT_ID, courseQuery());

      expect(Object.keys(result.items[0] ?? {})).not.toContain('fee');
    });

    it('передаёт поиск и окно страницы', async () => {
      await service.courses(ACCOUNT_ID, courseQuery({ search: 'front', page: 2, limit: 20 }));

      expect(repository.findCourses).toHaveBeenCalledWith(
        expect.objectContaining({ employeeId: EMPLOYEE_ID, search: 'front', skip: 20, take: 20 }),
      );
    });
  });

  // ────────────────────────────── Материалы ──────────────────────────────

  describe('Материалы своих групп (ТЗ 5.4, раздел «Material»)', () => {
    it('отдаёт урок с курсом, файлами и своими группами', async () => {
      const result = await service.materials(ACCOUNT_ID, materialQuery());

      expect(result.items[0]).toMatchObject({
        id: LESSON_ID,
        title: 'Введение в React',
        dayNumber: 1,
        course: { id: COURSE_ID, title: 'Frontend' },
        groups: [{ id: GROUP_ID, name: 'Frontend-1' }],
      });
      expect(result.items[0]?.files).toHaveLength(1);
      expect(result.items[0]?.files[0]).toMatchObject({
        title: 'Слайды по хукам',
        kind: ResourceKind.LECTURE,
        fileType: ResourceFileType.SLIDES,
      });
    });

    it('урок без материалов отдаётся с пустым списком файлов', async () => {
      repository.findMaterials.mockResolvedValue({ rows: [lessonRow({ files: [] })], total: 1 });

      const result = await service.materials(ACCOUNT_ID, materialQuery());

      expect(result.items[0]?.files).toEqual([]);
    });

    it('передаёт все фильтры и окно страницы', async () => {
      await service.materials(
        ACCOUNT_ID,
        materialQuery({ courseId: COURSE_ID, type: LessonType.PRACTICE, search: 'react' }),
      );

      expect(repository.findMaterials).toHaveBeenCalledWith(
        expect.objectContaining({
          employeeId: EMPLOYEE_ID,
          courseId: COURSE_ID,
          type: LessonType.PRACTICE,
          search: 'react',
        }),
      );
    });

    it('по умолчанию читается в порядке учебных дней', async () => {
      await service.materials(ACCOUNT_ID, materialQuery());

      expect(repository.findMaterials).toHaveBeenCalledWith(
        expect.objectContaining({
          sort: MentorMaterialSortField.DayNumber,
          order: SortOrder.Asc,
        }),
      );
    });

    it('422 на чужую группу в фильтре — материалы не запрашиваются', async () => {
      repository.findAssignment.mockResolvedValue(null);

      await expect(
        service.materials(ACCOUNT_ID, materialQuery({ groupId: OTHER_ID })),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.findMaterials).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────── Аванс о себе (ТЗ 5.4) ─────────────────────────

  describe('Свои заявки на аванс', () => {
    it('список спрашивается про свой профиль, а не про идентификатор из запроса', async () => {
      const query = avansQuery();

      await service.avansRequests(ACCOUNT_ID, query);

      expect(avans.findAll).toHaveBeenCalledWith(EMPLOYEE_ID, query);
    });

    it('подача заводит заявку о себе и подписывает её своим аккаунтом', async () => {
      const dto = { amount: 500, reason: 'Оплата аренды жилья', month: '2026-09' };

      await service.createAvansRequest(ACCOUNT_ID, dto);

      expect(avans.create).toHaveBeenCalledWith(EMPLOYEE_ID, dto, ACCOUNT_ID);
    });

    it('отзыв ищет заявку среди своих', async () => {
      await service.cancelAvansRequest(ACCOUNT_ID, AVANS_ID);

      expect(avans.remove).toHaveBeenCalledWith(EMPLOYEE_ID, AVANS_ID);
    });

    it('403 выведенному из штата — до обращения к заявкам', async () => {
      repository.findByAccountId.mockResolvedValue(profileRow({ status: EmployeeStatus.INACTIVE }));

      await expect(
        service.createAvansRequest(ACCOUNT_ID, {
          amount: 500,
          reason: 'Оплата аренды жилья',
          month: '2026-09',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(avans.create).not.toHaveBeenCalled();
    });

    it('404 аккаунту без профиля — до обращения к заявкам', async () => {
      repository.findByAccountId.mockResolvedValue(null);

      await expect(service.avansRequests(ACCOUNT_ID, avansQuery())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(avans.findAll).not.toHaveBeenCalled();
    });
  });
});
