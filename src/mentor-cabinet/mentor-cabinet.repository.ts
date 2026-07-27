import { Injectable } from '@nestjs/common';
import type { GroupMentorRole, GroupStatus, LessonType, Prisma, WeekDay } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import {
  MentorCourseSortField,
  MentorGroupSortField,
  MentorMaterialSortField,
  MentorTimetableSortField,
} from './dto';

/**
 * Профиль в том виде, в каком его видит сам сотрудник (ТЗ 5.4, раздел «Profile»).
 *
 * Чего здесь намеренно нет:
 *   - `account` — логин и статус входа: сотрудник и так вошёл, а `passwordHash`
 *     не должен попадать в выборку в принципе (то же правило, что в карточке
 *     сотрудника и в кабинете студента);
 *   - `formerStudentId` — служебная связь перевода Студент → Сотрудник (ТЗ 3.1),
 *     данные администрирования, а не профиля.
 *
 * Позиции, наоборот, есть: это ответ на вопрос «кто я в системе», и он же
 * объясняет сотруднику, почему одни разделы ему открыты, а другие нет.
 */
const MENTOR_PROFILE_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  middleName: true,
  phone: true,
  birthDate: true,
  gender: true,
  address: true,
  email: true,
  telegram: true,
  photoUrl: true,
  experience: true,
  description: true,
  status: true,
  hiredAt: true,
  createdAt: true,
  branch: { select: { id: true, name: true } },
  positions: {
    select: { position: { select: { id: true, name: true } } },
    orderBy: { position: { name: 'asc' } },
  },
} satisfies Prisma.EmployeeSelect;

export type MentorProfileRow = Prisma.EmployeeGetPayload<{
  select: typeof MENTOR_PROFILE_SELECT;
}>;

/**
 * Уровень месяца вместе со ставкой (ТЗ 5.4: «уровень + часовая ставка»).
 * Ставка читается из справочника по ссылке — решение сессии 0021: её
 * пересматривают для всей лестницы разом, а не для одного месяца.
 */
const MENTOR_LEVEL_SELECT = {
  month: true,
  level: { select: { id: true, name: true, hourlyRate: true, status: true } },
} satisfies Prisma.MentorLevelHistorySelect;

export type MentorLevelOfMonthRow = Prisma.MentorLevelHistoryGetPayload<{
  select: typeof MENTOR_LEVEL_SELECT;
}>;

/**
 * Группа под менторством вместе с ролью (ТЗ 5.4, раздел «Groups»).
 *
 * «Набрано» считается фильтрованным `_count` по действующим членствам —
 * тем же запросом, что в списке групп (сессия 0012): ментору нужно то же
 * число «набрано/вместимость», и второй способ его посчитать разошёлся бы
 * с первым.
 */
const MENTOR_GROUP_SELECT = {
  role: true,
  assignedAt: true,
  group: {
    select: {
      id: true,
      name: true,
      description: true,
      format: true,
      status: true,
      startDate: true,
      endDate: true,
      capacity: true,
      telegramUrl: true,
      course: { select: { id: true, title: true, subtitle: true } },
      branch: { select: { id: true, name: true } },
      _count: { select: { students: { where: { status: 'ACTIVE' } } } },
    },
  },
} satisfies Prisma.GroupMentorSelect;

export type MentorGroupRow = Prisma.GroupMentorGetPayload<{ select: typeof MENTOR_GROUP_SELECT }>;

/**
 * Занятие в расписании ментора (ТЗ 5.4, раздел «Timetable»; форма слота — ТЗ 5.5).
 * `mentorId` в выборке нужен, чтобы отличить занятие, которое сотрудник ведёт
 * лично, от занятия его группы, назначенного коллеге.
 */
const MENTOR_SLOT_SELECT = {
  id: true,
  dayOfWeek: true,
  startMinute: true,
  endMinute: true,
  mentorId: true,
  group: {
    select: { id: true, name: true, course: { select: { id: true, title: true } } },
  },
  room: { select: { id: true, name: true } },
  mentor: { select: { id: true, firstName: true, lastName: true, middleName: true } },
} satisfies Prisma.ScheduleSlotSelect;

export type MentorSlotRow = Prisma.ScheduleSlotGetPayload<{ select: typeof MENTOR_SLOT_SELECT }>;

/**
 * Курс, по которому сотрудник ведёт хотя бы одну группу (ТЗ 5.4, раздел «Courses»).
 *
 * Стоимости курса (`fee`) здесь нет намеренно: раздел отвечает на вопрос
 * «что я преподаю», а не «сколько это стоит», и цена — данные бухгалтерии
 * (ТЗ 5.16), доступ к которым даётся правами. Кабинет прав не спрашивает,
 * поэтому лишнего он и не показывает — то же соображение, по которому
 * из профиля студента убраны заметки центра (сессия 0017).
 */
const MENTOR_COURSE_SELECT = {
  id: true,
  title: true,
  subtitle: true,
  description: true,
  colorPrimary: true,
  colorSecondary: true,
  logoUrl: true,
  durationValue: true,
  durationUnit: true,
  isLastCourse: true,
  status: true,
  createdAt: true,
} satisfies Prisma.CourseSelect;

export type MentorCourseRow = Prisma.CourseGetPayload<{ select: typeof MENTOR_COURSE_SELECT }>;

/**
 * Урок программы вместе с материалами (ТЗ 5.4, раздел «Material»).
 *
 * Файлы отдаются прямо в строке, а не счётчиком, как в силлабусе (сессия 0009):
 * там список программы ведёт методист и файлы читаются с карточки урока,
 * здесь же весь смысл раздела — ссылки, которые ментор открывает перед занятием.
 */
const MENTOR_LESSON_SELECT = {
  id: true,
  courseId: true,
  dayNumber: true,
  title: true,
  description: true,
  type: true,
  status: true,
  createdAt: true,
  course: { select: { id: true, title: true } },
  files: {
    select: {
      id: true,
      title: true,
      kind: true,
      fileType: true,
      url: true,
      description: true,
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.SyllabusLessonSelect;

export type MentorLessonRow = Prisma.SyllabusLessonGetPayload<{
  select: typeof MENTOR_LESSON_SELECT;
}>;

/** Группа мультивыбора «Show to group», подставляемая к курсу и к уроку страницы. */
export interface MentorGroupRef {
  id: string;
  name: string;
}

/** Строка «моя группа этого курса» — собирается одним запросом на страницу. */
export interface MentorCourseGroupRow extends MentorGroupRef {
  courseId: string;
}

/** Строка «этот урок открыт моей группе» — тоже один запрос на страницу. */
export interface MentorLessonGroupRow extends MentorGroupRef {
  lessonId: string;
}

export interface MentorGroupListParams {
  employeeId: string;
  search?: string;
  role?: GroupMentorRole;
  status?: GroupStatus;
  sort: MentorGroupSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface MentorTimetableListParams {
  employeeId: string;
  search?: string;
  groupId?: string;
  dayOfWeek?: WeekDay;
  /** `true` — только свои занятия, `false` — только занятия коллег в моих группах. */
  onlyMine?: boolean;
  sort: MentorTimetableSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface MentorCourseListParams {
  employeeId: string;
  search?: string;
  sort: MentorCourseSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface MentorMaterialListParams {
  employeeId: string;
  search?: string;
  groupId?: string;
  courseId?: string;
  type?: LessonType;
  sort: MentorMaterialSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

/**
 * Доступ к данным кабинета ментора (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 *
 * Общее у всех выборок одно: они сужены **менторством вызывающего**
 * (`mentors: { some: { employeeId } }`), а не идентификатором из запроса.
 * Поэтому чужие группы, курсы и материалы сюда не попадают по построению,
 * а не по забытой проверке.
 */
@Injectable()
export class MentorCabinetRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Профиль по аккаунту вызывающего. `Employee.accountId` уникален (ТЗ 3.1:
   * к аккаунту привязан профиль Student ИЛИ Employee), поэтому это `findUnique`,
   * а не поиск.
   */
  findByAccountId(accountId: string): Promise<MentorProfileRow | null> {
    return this.prisma.employee.findUnique({
      where: { accountId },
      select: MENTOR_PROFILE_SELECT,
    });
  }

  /**
   * Уровень сотрудника в конкретном месяце. Ближайший предыдущий **не тянется**:
   * месяц без записи означает, что уровня не было (решение сессии 0021), —
   * и это правило выполняется здесь тем, что запрос ищет ровно один месяц.
   */
  findLevelOfMonth(employeeId: string, month: Date): Promise<MentorLevelOfMonthRow | null> {
    return this.prisma.mentorLevelHistory.findUnique({
      where: { employeeId_month: { employeeId, month } },
      select: MENTOR_LEVEL_SELECT,
    });
  }

  async findGroups(
    params: MentorGroupListParams,
  ): Promise<{ rows: MentorGroupRow[]; total: number }> {
    const where: Prisma.GroupMentorWhereInput = {
      employeeId: params.employeeId,
      ...(params.role === undefined ? {} : { role: params.role }),
      ...(params.status === undefined ? {} : { group: { status: params.status } }),
      ...(params.search === undefined
        ? {}
        : {
            OR: [
              { group: { name: { contains: params.search, mode: 'insensitive' } } },
              { group: { course: { title: { contains: params.search, mode: 'insensitive' } } } },
            ],
          }),
    };

    // Ключ `orderBy` собирается ветвлением, а не из строки: вычисляемое поле
    // прошло бы типизацию Prisma и упало бы уже в БД.
    const orderBy: Prisma.GroupMentorOrderByWithRelationInput[] =
      params.sort === MentorGroupSortField.Name
        ? [{ group: { name: params.order } }]
        : [{ assignedAt: params.order }];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.groupMentor.findMany({
        where,
        select: MENTOR_GROUP_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.groupMentor.count({ where }),
    ]);

    return { rows, total };
  }

  /**
   * Занятия групп, где сотрудник числится ментором.
   *
   * Отбор идёт **от менторства**, а не от `ScheduleSlot.mentorId`: ведущий
   * на слоте необязателен (сессия 0011), и у большинства групп он не проставлен —
   * выборка по нему отдала бы пустое расписание почти каждому ментору.
   * Кто ведёт лично, показывает поле `mine`, а сузить список до своих занятий
   * можно фильтром `onlyMine`.
   */
  async findTimetable(
    params: MentorTimetableListParams,
  ): Promise<{ rows: MentorSlotRow[]; total: number }> {
    const where: Prisma.ScheduleSlotWhereInput = {
      group: { mentors: { some: { employeeId: params.employeeId } } },
      ...(params.groupId === undefined ? {} : { groupId: params.groupId }),
      ...(params.dayOfWeek === undefined ? {} : { dayOfWeek: params.dayOfWeek }),
      AND: [
        // «Не моё» описано явным `OR` с `null`, а не через `not`: у необязательной
        // колонки отрицание в SQL отбрасывает пустые значения, и занятия
        // без ведущего пропали бы из ответа молча.
        ...(params.onlyMine === undefined
          ? []
          : params.onlyMine
            ? [{ mentorId: params.employeeId }]
            : [{ OR: [{ mentorId: null }, { mentorId: { not: params.employeeId } }] }]),
        ...(params.search === undefined
          ? []
          : [
              {
                OR: [
                  { group: { name: { contains: params.search, mode: 'insensitive' as const } } },
                  { room: { name: { contains: params.search, mode: 'insensitive' as const } } },
                  {
                    group: {
                      course: { title: { contains: params.search, mode: 'insensitive' as const } },
                    },
                  },
                ],
              },
            ]),
      ],
    };

    // Порядок дней недели даёт сам тип в PostgreSQL: он сортируется в порядке
    // объявления значений, а объявлены они с понедельника.
    const orderBy: Prisma.ScheduleSlotOrderByWithRelationInput[] =
      params.sort === MentorTimetableSortField.StartTime
        ? [{ startMinute: params.order }, { dayOfWeek: params.order }]
        : [{ dayOfWeek: params.order }, { startMinute: params.order }];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.scheduleSlot.findMany({
        where,
        select: MENTOR_SLOT_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.scheduleSlot.count({ where }),
    ]);

    return { rows, total };
  }

  async findCourses(
    params: MentorCourseListParams,
  ): Promise<{ rows: MentorCourseRow[]; total: number }> {
    const where: Prisma.CourseWhereInput = {
      groups: { some: { mentors: { some: { employeeId: params.employeeId } } } },
      ...(params.search === undefined
        ? {}
        : {
            OR: [
              { title: { contains: params.search, mode: 'insensitive' } },
              { subtitle: { contains: params.search, mode: 'insensitive' } },
            ],
          }),
    };

    const orderBy: Prisma.CourseOrderByWithRelationInput[] =
      params.sort === MentorCourseSortField.CreatedAt
        ? [{ createdAt: params.order }]
        : [{ title: params.order }];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.course.findMany({
        where,
        select: MENTOR_COURSE_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.course.count({ where }),
    ]);

    return { rows, total };
  }

  /**
   * Мои группы по курсам страницы — **один запрос на страницу, а не на строку**
   * (тот же приём, что с агрегатами баллов в сессии 0019). Отдельным запросом,
   * а не вложенной выборкой, потому что фильтр в ней зависел бы от вызывающего,
   * и статический `select` перестал бы быть статическим.
   */
  async findGroupsOfCourses(
    employeeId: string,
    courseIds: readonly string[],
  ): Promise<MentorCourseGroupRow[]> {
    if (courseIds.length === 0) return [];

    const rows = await this.prisma.group.findMany({
      where: {
        courseId: { in: [...courseIds] },
        mentors: { some: { employeeId } },
      },
      select: { id: true, name: true, courseId: true },
      orderBy: { name: 'asc' },
    });

    return rows;
  }

  async findMaterials(
    params: MentorMaterialListParams,
  ): Promise<{ rows: MentorLessonRow[]; total: number }> {
    const where: Prisma.SyllabusLessonWhereInput = {
      // «Show to group» (ТЗ 5.6) — единственный источник этого раздела: ментор
      // видит не всю программу курса, а то, что открыто его группам.
      visibleToGroups: {
        some: {
          group: { mentors: { some: { employeeId: params.employeeId } } },
          ...(params.groupId === undefined ? {} : { groupId: params.groupId }),
        },
      },
      ...(params.courseId === undefined ? {} : { courseId: params.courseId }),
      ...(params.type === undefined ? {} : { type: params.type }),
      ...(params.search === undefined
        ? {}
        : {
            OR: [
              { title: { contains: params.search, mode: 'insensitive' } },
              { description: { contains: params.search, mode: 'insensitive' } },
            ],
          }),
    };

    // Вторым ключом идёт время создания: номер дня не уникален внутри курса
    // (решение сессии 0009 — «Day 1 — лекция» и «Day 1 — практика»), и без
    // него порядок уроков одного дня менялся бы между страницами.
    const orderBy: Prisma.SyllabusLessonOrderByWithRelationInput[] =
      params.sort === MentorMaterialSortField.Title
        ? [{ title: params.order }, { createdAt: 'asc' }]
        : params.sort === MentorMaterialSortField.CreatedAt
          ? [{ createdAt: params.order }]
          : [{ dayNumber: params.order }, { createdAt: 'asc' }];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.syllabusLesson.findMany({
        where,
        select: MENTOR_LESSON_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.syllabusLesson.count({ where }),
    ]);

    return { rows, total };
  }

  /** Кому из моих групп открыты уроки страницы — тоже один запрос на страницу. */
  async findGroupsOfLessons(
    employeeId: string,
    lessonIds: readonly string[],
  ): Promise<MentorLessonGroupRow[]> {
    if (lessonIds.length === 0) return [];

    const rows = await this.prisma.syllabusLessonGroup.findMany({
      where: {
        lessonId: { in: [...lessonIds] },
        group: { mentors: { some: { employeeId } } },
      },
      select: { lessonId: true, group: { select: { id: true, name: true } } },
      orderBy: { group: { name: 'asc' } },
    });

    return rows.map(({ lessonId, group }) => ({ lessonId, id: group.id, name: group.name }));
  }

  /**
   * Веду ли я эту группу — под фильтр `groupId` расписания и материалов.
   * Чужая и несуществующая группа отвечают одинаково: кабинет не должен
   * работать способом перебрать, какие группы вообще есть в центре
   * (то же решение, что в кабинете студента, сессия 0017).
   */
  findAssignment(employeeId: string, groupId: string): Promise<{ groupId: string } | null> {
    return this.prisma.groupMentor.findUnique({
      where: { groupId_employeeId: { groupId, employeeId } },
      select: { groupId: true },
    });
  }
}
