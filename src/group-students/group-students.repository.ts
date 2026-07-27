import { Injectable } from '@nestjs/common';
import type { Prisma, StudentStatus } from '@prisma/client';
import { GroupStudentStatus } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { GroupStudentSortField } from './dto';

const GROUP_STUDENT_SELECT = {
  groupId: true,
  studentId: true,
  status: true,
  statusReason: true,
  statusChangedAt: true,
  enrolledAt: true,
  // Профиль отдаётся вместе с членством: список из одних идентификаторов
  // заставил бы карточку группы догружать студента по каждой строке.
  student: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      photoUrl: true,
      status: true,
    },
  },
  // Откуда переведён (ТЗ 5.5): в списке видно, что студент пришёл из другого
  // потока, без второго запроса за названием группы.
  transferredFromGroup: { select: { id: true, name: true } },
} satisfies Prisma.GroupStudentSelect;

export type GroupStudentRow = Prisma.GroupStudentGetPayload<{
  select: typeof GROUP_STUDENT_SELECT;
}>;

/** Группа в том виде, в каком её проверяет сервис: курс нужен правилам состава. */
export type StudentGroup = Prisma.GroupGetPayload<{
  select: { id: true; name: true; courseId: true; capacity: true };
}>;

/** Студент из тела запроса — только то, чем сервис объясняет отказ. */
export type StudentCandidate = Prisma.StudentGetPayload<{
  select: { id: true; firstName: true; lastName: true };
}>;

/** Студент, найденный по телефону из файла импорта. */
export type StudentByPhone = Prisma.StudentGetPayload<{
  select: { id: true; firstName: true; lastName: true; phone: true };
}>;

/** Действующее членство в другой группе того же курса — причина отказа (409). */
export type CompetingMembership = Prisma.GroupStudentGetPayload<{
  select: {
    studentId: true;
    groupId: true;
    group: { select: { name: true } };
    student: { select: { firstName: true; lastName: true } };
  };
}>;

/**
 * Профиль вместе со всеми его членствами — из них выводится статус студента
 * (ТЗ 5.3). Читаются и закрытые: правило смотрит на последнее по времени.
 */
export type StudentStatusSnapshot = Prisma.StudentGetPayload<{
  select: {
    id: true;
    status: true;
    groups: { select: { status: true; statusChangedAt: true } };
  };
}>;

/** Новый статус профиля, посчитанный сервисом. */
export interface StudentStatusUpdate {
  studentId: string;
  status: StudentStatus;
}

/** Отбор состава: общий для постраничного списка и для выгрузки. */
export interface GroupStudentFilter {
  groupId: string;
  search?: string;
  status?: GroupStudentStatus;
}

export interface GroupStudentListParams extends GroupStudentFilter {
  sort: GroupStudentSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

/**
 * Потолок выгрузки. Состав группы — это десятки строк (`capacity` ограничена
 * сотней), и запрос, вытягивающий больше, означает не выгрузку карточки,
 * а попытку выкачать базу одним обращением.
 */
export const MAX_EXPORT_ROWS = 5000;

export interface TransferInput {
  fromGroupId: string;
  toGroupId: string;
  studentIds: string[];
  reason: string;
  changedAt: Date;
}

/** Отбор строк состава — один на постраничный список и на выгрузку. */
const whereOf = (filter: GroupStudentFilter): Prisma.GroupStudentWhereInput => ({
  groupId: filter.groupId,
  ...(filter.status === undefined ? {} : { status: filter.status }),
  ...(filter.search === undefined
    ? {}
    : {
        student: {
          OR: [
            { firstName: { contains: filter.search, mode: 'insensitive' } },
            { lastName: { contains: filter.search, mode: 'insensitive' } },
            { phone: { contains: filter.search } },
          ],
        },
      }),
});

/**
 * Доступ к данным состава группы (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class GroupStudentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(
    params: GroupStudentListParams,
  ): Promise<{ rows: GroupStudentRow[]; total: number }> {
    const where = whereOf(params);

    // Ключ `orderBy` собирается ветвлением, а не из строки: вычисляемое поле
    // прошло бы типизацию Prisma и упало бы уже в БД.
    //
    // По имени сортировка идёт «фамилия, имя» — так список читают на карточке
    // группы, и так же устроен индекс `students(lastName, firstName)`.
    const orderBy: Prisma.GroupStudentOrderByWithRelationInput[] =
      params.sort === GroupStudentSortField.EnrolledAt
        ? [{ enrolledAt: params.order }]
        : [{ student: { lastName: params.order } }, { student: { firstName: params.order } }];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.groupStudent.findMany({
        where,
        select: GROUP_STUDENT_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.groupStudent.count({ where }),
    ]);

    return { rows, total };
  }

  /**
   * Весь отобранный состав для выгрузки (ТЗ 5.5) — без окна страницы, но
   * с потолком: файл собирается в памяти, и «выгрузить всё» не должно
   * означать «прочитать сколько угодно».
   *
   * Порядок фиксированный («фамилия, имя»): у файла нет экрана с сортировкой,
   * а два запуска выгрузки должны давать одинаковые строки в одинаковом
   * порядке — иначе их нельзя сравнить между собой.
   */
  findAllForExport(filter: GroupStudentFilter): Promise<GroupStudentRow[]> {
    return this.prisma.groupStudent.findMany({
      where: whereOf(filter),
      select: GROUP_STUDENT_SELECT,
      orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
      take: MAX_EXPORT_ROWS,
    });
  }

  /**
   * Профили по телефонам из файла импорта. `Student.phone` уникален, поэтому
   * телефон однозначно указывает на человека — и импорту не нужен ни один
   * внутренний идентификатор, которого у оператора всё равно нет.
   */
  findStudentsByPhones(phones: string[]): Promise<StudentByPhone[]> {
    return this.prisma.student.findMany({
      where: { phone: { in: phones } },
      select: { id: true, firstName: true, lastName: true, phone: true },
    });
  }

  findGroup(id: string): Promise<StudentGroup | null> {
    return this.prisma.group.findUnique({
      where: { id },
      select: { id: true, name: true, courseId: true, capacity: true },
    });
  }

  /** Существующие профили из переданных идентификаторов — недостающие сервис назовёт сам. */
  findStudents(ids: string[]): Promise<StudentCandidate[]> {
    return this.prisma.student.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true },
    });
  }

  findOne(groupId: string, studentId: string): Promise<GroupStudentRow | null> {
    return this.prisma.groupStudent.findUnique({
      where: { groupId_studentId: { groupId, studentId } },
      select: GROUP_STUDENT_SELECT,
    });
  }

  /** Членства перечисленных студентов в этой группе — включая закрытые. */
  findMemberships(groupId: string, studentIds: string[]): Promise<GroupStudentRow[]> {
    return this.prisma.groupStudent.findMany({
      where: { groupId, studentId: { in: studentIds } },
      select: GROUP_STUDENT_SELECT,
    });
  }

  /**
   * Действующие членства перечисленных студентов в **других** группах того же
   * курса. На них держится правило «одно активное членство на курс» (решение
   * сессии 0012): учиться на Frontend и English параллельно можно, в двух
   * группах одного курса — нет.
   *
   * `exceptGroupIds` — группы, которые в счёт не идут: при зачислении это сама
   * группа (у неё свой ответ «уже в составе»), при переводе — ещё и та, из
   * которой переводят: её членство закрывается этим же запросом.
   */
  findCompetingMemberships(
    courseId: string,
    studentIds: string[],
    exceptGroupIds: string[],
  ): Promise<CompetingMembership[]> {
    return this.prisma.groupStudent.findMany({
      where: {
        studentId: { in: studentIds },
        status: GroupStudentStatus.ACTIVE,
        groupId: { notIn: exceptGroupIds },
        group: { courseId },
      },
      select: {
        studentId: true,
        groupId: true,
        group: { select: { name: true } },
        student: { select: { firstName: true, lastName: true } },
      },
    });
  }

  /** «Набрано» из «Required students = набрано/вместимость» (ТЗ 5.5). */
  countActive(groupId: string): Promise<number> {
    return this.prisma.groupStudent.count({
      where: { groupId, status: GroupStudentStatus.ACTIVE },
    });
  }

  /**
   * Зачисление пачкой, одной транзакцией: группа с половиной набора — состояние
   * хуже, чем отказ целиком (ТЗ 7).
   *
   * `upsert`, а не `createMany`: вернувшийся в ту же группу студент занимает
   * прежнюю строку (составной первичный ключ не позволяет второй). Причина
   * и дата прежнего ухода при этом снимаются — иначе действующее членство
   * несло бы объяснение, почему студент когда-то ушёл.
   */
  enroll(groupId: string, studentIds: string[], enrolledAt: Date): Promise<GroupStudentRow[]> {
    return this.prisma.$transaction(async (tx) => {
      const rows: GroupStudentRow[] = [];

      for (const studentId of studentIds) {
        rows.push(
          await tx.groupStudent.upsert({
            where: { groupId_studentId: { groupId, studentId } },
            create: { groupId, studentId, enrolledAt },
            update: {
              status: GroupStudentStatus.ACTIVE,
              statusReason: null,
              statusChangedAt: null,
              transferredFromGroupId: null,
              enrolledAt,
            },
            select: GROUP_STUDENT_SELECT,
          }),
        );
      }

      return rows;
    });
  }

  /** Массовая смена статуса участия с обязательной причиной (ТЗ 5.5). */
  changeStatus(
    groupId: string,
    studentIds: string[],
    status: GroupStudentStatus,
    reason: string,
    changedAt: Date,
  ): Promise<GroupStudentRow[]> {
    return this.prisma.$transaction(async (tx) => {
      const rows: GroupStudentRow[] = [];

      for (const studentId of studentIds) {
        rows.push(
          await tx.groupStudent.update({
            where: { groupId_studentId: { groupId, studentId } },
            data: { status, statusReason: reason, statusChangedAt: changedAt },
            select: GROUP_STUDENT_SELECT,
          }),
        );
      }

      return rows;
    });
  }

  /**
   * Перевод в другую группу (ТЗ 5.5) — две записи на студента в одной
   * транзакции: прежнее членство закрывается статусом `TRANSFERRED` с причиной
   * и датой, в группе назначения заводится действующее. Оборванный на середине
   * перевод оставил бы студента либо в двух группах сразу, либо ни в одной.
   *
   * Возвращаются членства в группе назначения — именно их показывает экран
   * после перевода.
   */
  transfer(input: TransferInput): Promise<GroupStudentRow[]> {
    return this.prisma.$transaction(async (tx) => {
      await tx.groupStudent.updateMany({
        where: { groupId: input.fromGroupId, studentId: { in: input.studentIds } },
        data: {
          status: GroupStudentStatus.TRANSFERRED,
          statusReason: input.reason,
          statusChangedAt: input.changedAt,
        },
      });

      const rows: GroupStudentRow[] = [];

      for (const studentId of input.studentIds) {
        rows.push(
          await tx.groupStudent.upsert({
            where: { groupId_studentId: { groupId: input.toGroupId, studentId } },
            create: {
              groupId: input.toGroupId,
              studentId,
              transferredFromGroupId: input.fromGroupId,
              enrolledAt: input.changedAt,
            },
            update: {
              status: GroupStudentStatus.ACTIVE,
              statusReason: null,
              statusChangedAt: null,
              transferredFromGroupId: input.fromGroupId,
              enrolledAt: input.changedAt,
            },
            select: GROUP_STUDENT_SELECT,
          }),
        );
      }

      return rows;
    });
  }

  async delete(groupId: string, studentId: string): Promise<void> {
    await this.prisma.groupStudent.delete({
      where: { groupId_studentId: { groupId, studentId } },
    });
  }

  /**
   * Профили вместе со **всеми** их членствами — во всех группах, а не только
   * в той, где что-то менялось: статус студента отвечает за него целиком,
   * и уход с одного курса ничего не значит, пока он учится на другом.
   */
  findStudentsWithMemberships(studentIds: string[]): Promise<StudentStatusSnapshot[]> {
    return this.prisma.student.findMany({
      where: { id: { in: studentIds } },
      select: {
        id: true,
        status: true,
        groups: { select: { status: true, statusChangedAt: true } },
      },
    });
  }

  /**
   * Пересчитанные статусы профилей — одной транзакцией.
   *
   * Сюда приходят только те, у кого статус действительно меняется: холостая
   * запись двигала бы `updatedAt` и превращала бы «когда правили карточку»
   * в бессмысленное значение.
   */
  async setStudentStatuses(updates: StudentStatusUpdate[]): Promise<void> {
    if (updates.length === 0) return;

    await this.prisma.$transaction(
      updates.map(({ studentId, status }) =>
        this.prisma.student.update({ where: { id: studentId }, data: { status } }),
      ),
    );
  }
}
