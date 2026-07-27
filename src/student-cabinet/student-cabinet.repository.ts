import { Injectable } from '@nestjs/common';
import type { GroupStudentStatus, Prisma, WeekDay } from '@prisma/client';
import { GroupStudentStatus as MembershipStatus } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { MeGroupSortField, MeScheduleSortField } from './dto';

/**
 * Профиль в том виде, в каком его видит сам студент (ТЗ 5.3: «свой профиль»).
 *
 * Чего здесь намеренно нет:
 *   - `notes` — заметки администратора о студенте, поле формы карточки, а не
 *     данные самого человека;
 *   - `account` — логин и статус входа: студент и так вошёл, а `passwordHash`
 *     не должен попадать в выборку в принципе (то же правило, что в карточке);
 *   - заметки сотрудников (`Feedback`) — внутренние наблюдения центра.
 */
const ME_PROFILE_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  birthDate: true,
  gender: true,
  address: true,
  email: true,
  extraPhones: true,
  telegram: true,
  photoUrl: true,
  status: true,
  createdAt: true,
  branch: { select: { id: true, name: true } },
  parents: {
    select: {
      relation: true,
      parent: { select: { id: true, firstName: true, lastName: true, phone: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.StudentSelect;

export type MeProfileRow = Prisma.StudentGetPayload<{ select: typeof ME_PROFILE_SELECT }>;

/**
 * Членство студента вместе с группой, курсом и менторами (ТЗ 5.3: «свои группы»).
 *
 * Менторы отдаются именами, а не идентификаторами: экран кабинета должен
 * показать, кто ведёт группу, не догружая профили сотрудников построчно.
 * Контактов ментора здесь нет — студенту достаточно имени.
 */
const ME_MEMBERSHIP_SELECT = {
  status: true,
  statusReason: true,
  statusChangedAt: true,
  enrolledAt: true,
  group: {
    select: {
      id: true,
      name: true,
      format: true,
      status: true,
      startDate: true,
      endDate: true,
      telegramUrl: true,
      course: { select: { id: true, title: true, subtitle: true } },
      branch: { select: { id: true, name: true } },
      mentors: {
        select: {
          role: true,
          employee: {
            select: { id: true, firstName: true, lastName: true, middleName: true },
          },
        },
        orderBy: [{ employee: { lastName: 'asc' } }, { employee: { firstName: 'asc' } }],
      },
    },
  },
} satisfies Prisma.GroupStudentSelect;

export type MeMembershipRow = Prisma.GroupStudentGetPayload<{
  select: typeof ME_MEMBERSHIP_SELECT;
}>;

/** Занятие в расписании студента (ТЗ 5.3: «расписание»; форма слота — ТЗ 5.5). */
const ME_SLOT_SELECT = {
  id: true,
  dayOfWeek: true,
  startMinute: true,
  endMinute: true,
  group: {
    select: { id: true, name: true, course: { select: { id: true, title: true } } },
  },
  room: { select: { id: true, name: true } },
  mentor: { select: { id: true, firstName: true, lastName: true, middleName: true } },
} satisfies Prisma.ScheduleSlotSelect;

export type MeSlotRow = Prisma.ScheduleSlotGetPayload<{ select: typeof ME_SLOT_SELECT }>;

export interface MeMembershipListParams {
  studentId: string;
  search?: string;
  status?: GroupStudentStatus;
  sort: MeGroupSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface MeScheduleListParams {
  studentId: string;
  search?: string;
  groupId?: string;
  dayOfWeek?: WeekDay;
  sort: MeScheduleSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

/**
 * Доступ к данным кабинета студента (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class StudentCabinetRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Профиль по аккаунту вызывающего. `Student.accountId` уникален (ТЗ 3.1:
   * к аккаунту привязан профиль Student ИЛИ Employee), поэтому это `findUnique`,
   * а не поиск.
   */
  findByAccountId(accountId: string): Promise<MeProfileRow | null> {
    return this.prisma.student.findUnique({ where: { accountId }, select: ME_PROFILE_SELECT });
  }

  async findMemberships(
    params: MeMembershipListParams,
  ): Promise<{ rows: MeMembershipRow[]; total: number }> {
    const where: Prisma.GroupStudentWhereInput = {
      studentId: params.studentId,
      ...(params.status === undefined ? {} : { status: params.status }),
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
    const orderBy: Prisma.GroupStudentOrderByWithRelationInput[] =
      params.sort === MeGroupSortField.Name
        ? [{ group: { name: params.order } }]
        : [{ enrolledAt: params.order }];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.groupStudent.findMany({
        where,
        select: ME_MEMBERSHIP_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.groupStudent.count({ where }),
    ]);

    return { rows, total };
  }

  /**
   * Занятия групп, в которых студент учится **сейчас**.
   *
   * Отбор идёт от действующего членства, а не от списка идентификаторов групп:
   * иначе «мои группы» и «моё расписание» держались бы на двух разных ответах
   * и разошлись бы при смене состава между запросами.
   */
  async findSchedule(params: MeScheduleListParams): Promise<{ rows: MeSlotRow[]; total: number }> {
    const where: Prisma.ScheduleSlotWhereInput = {
      group: {
        students: { some: { studentId: params.studentId, status: MembershipStatus.ACTIVE } },
      },
      ...(params.groupId === undefined ? {} : { groupId: params.groupId }),
      ...(params.dayOfWeek === undefined ? {} : { dayOfWeek: params.dayOfWeek }),
      ...(params.search === undefined
        ? {}
        : {
            OR: [
              { group: { name: { contains: params.search, mode: 'insensitive' } } },
              { room: { name: { contains: params.search, mode: 'insensitive' } } },
              { mentor: { firstName: { contains: params.search, mode: 'insensitive' } } },
              { mentor: { lastName: { contains: params.search, mode: 'insensitive' } } },
            ],
          }),
    };

    // Порядок дней недели даёт сам тип в PostgreSQL: он сортируется в порядке
    // объявления значений, а объявлены они с понедельника.
    const orderBy: Prisma.ScheduleSlotOrderByWithRelationInput[] =
      params.sort === MeScheduleSortField.StartTime
        ? [{ startMinute: params.order }, { dayOfWeek: params.order }]
        : [{ dayOfWeek: params.order }, { startMinute: params.order }];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.scheduleSlot.findMany({
        where,
        select: ME_SLOT_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.scheduleSlot.count({ where }),
    ]);

    return { rows, total };
  }

  /**
   * Учится ли студент в этой группе сейчас — под фильтр `groupId` расписания.
   * Чужая и несуществующая группа отвечают одинаково: кабинет не должен
   * работать способом проверить, какие группы вообще есть в центре.
   */
  findActiveMembership(studentId: string, groupId: string): Promise<{ groupId: string } | null> {
    return this.prisma.groupStudent.findFirst({
      where: { studentId, groupId, status: MembershipStatus.ACTIVE },
      select: { groupId: true },
    });
  }
}
