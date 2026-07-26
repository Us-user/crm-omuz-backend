import { Injectable } from '@nestjs/common';
import type { GroupMentorRole, Prisma } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { GroupMentorSortField } from './dto';

const GROUP_MENTOR_SELECT = {
  groupId: true,
  employeeId: true,
  role: true,
  assignedAt: true,
  // Профиль отдаётся вместе с назначением: список из одних идентификаторов
  // заставил бы карточку группы догружать сотрудника по каждой строке.
  employee: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      middleName: true,
      phone: true,
      photoUrl: true,
      status: true,
    },
  },
} satisfies Prisma.GroupMentorSelect;

export type GroupMentorRow = Prisma.GroupMentorGetPayload<{ select: typeof GROUP_MENTOR_SELECT }>;

/** Сотрудник в том виде, в каком его проверяет сервис перед назначением. */
export type MentorCandidate = Prisma.EmployeeGetPayload<{
  select: { id: true; firstName: true; lastName: true; status: true };
}>;

export interface GroupMentorListParams {
  groupId: string;
  search?: string;
  role?: GroupMentorRole;
  sort: GroupMentorSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface GroupMentorWriteInput {
  groupId: string;
  employeeId: string;
  role?: GroupMentorRole;
}

/**
 * Доступ к данным менторов группы (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class GroupMentorsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(
    params: GroupMentorListParams,
  ): Promise<{ rows: GroupMentorRow[]; total: number }> {
    const where: Prisma.GroupMentorWhereInput = {
      groupId: params.groupId,
      ...(params.role === undefined ? {} : { role: params.role }),
      ...(params.search === undefined
        ? {}
        : {
            employee: {
              OR: [
                { firstName: { contains: params.search, mode: 'insensitive' } },
                { lastName: { contains: params.search, mode: 'insensitive' } },
                { phone: { contains: params.search } },
              ],
            },
          }),
    };

    // Ключ `orderBy` собирается ветвлением, а не из строки: вычисляемое поле
    // прошло бы типизацию Prisma и упало бы уже в БД.
    //
    // По имени сортировка идёт «фамилия, имя» — так список читают на карточке
    // группы, и так же устроен индекс `employees(lastName, firstName)`.
    const orderBy: Prisma.GroupMentorOrderByWithRelationInput[] =
      params.sort === GroupMentorSortField.AssignedAt
        ? [{ assignedAt: params.order }]
        : [{ employee: { lastName: params.order } }, { employee: { firstName: params.order } }];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.groupMentor.findMany({
        where,
        select: GROUP_MENTOR_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.groupMentor.count({ where }),
    ]);

    return { rows, total };
  }

  findGroup(id: string): Promise<{ id: string; name: string } | null> {
    return this.prisma.group.findUnique({ where: { id }, select: { id: true, name: true } });
  }

  findEmployee(id: string): Promise<MentorCandidate | null> {
    return this.prisma.employee.findUnique({
      where: { id },
      select: { id: true, firstName: true, lastName: true, status: true },
    });
  }

  findOne(groupId: string, employeeId: string): Promise<GroupMentorRow | null> {
    return this.prisma.groupMentor.findUnique({
      where: { groupId_employeeId: { groupId, employeeId } },
      select: GROUP_MENTOR_SELECT,
    });
  }

  create(input: GroupMentorWriteInput): Promise<GroupMentorRow> {
    return this.prisma.groupMentor.create({ data: input, select: GROUP_MENTOR_SELECT });
  }

  updateRole(groupId: string, employeeId: string, role: GroupMentorRole): Promise<GroupMentorRow> {
    return this.prisma.groupMentor.update({
      where: { groupId_employeeId: { groupId, employeeId } },
      data: { role },
      select: GROUP_MENTOR_SELECT,
    });
  }

  async delete(groupId: string, employeeId: string): Promise<void> {
    await this.prisma.groupMentor.delete({
      where: { groupId_employeeId: { groupId, employeeId } },
    });
  }
}
