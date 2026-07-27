import { Injectable } from '@nestjs/common';
import type { GraduateEmployment, Prisma, StudentStatus } from '@prisma/client';
import { GroupStudentStatus } from '@prisma/client';

import type { SortOrder } from '../common';
// Прямым путём, а не через barrel `../performance`: нужен один общий фильтр
// недель, а не сервис и репозиторий успеваемости (правило сессии 0007).
import { FINALIZED_WEEK_FILTER } from '../performance/performance';
import { PrismaService } from '../prisma/prisma.service';
import { GraduateSortField } from './dto';

/**
 * Строка витрины выпускников (ТЗ 5.11).
 *
 * Профиль, группа, курс и филиал отдаются вместе со строкой: список читают
 * целиком, и догрузка каждого поля превратила бы одну таблицу в сотню запросов
 * (тот же приём, что в витрине покинувших курсы, 0025).
 */
const GRADUATE_SELECT = {
  id: true,
  graduatedAt: true,
  points: true,
  weeksCount: true,
  employment: true,
  workPlace: true,
  certificateSerial: true,
  certificateIssuedAt: true,
  createdAt: true,
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
  group: {
    select: {
      id: true,
      name: true,
      course: { select: { id: true, title: true } },
      branch: { select: { id: true, name: true } },
    },
  },
  certificateIssuedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.GraduateSelect;

export type GraduateRow = Prisma.GraduateGetPayload<{ select: typeof GRADUATE_SELECT }>;

/** Группа в том виде, в каком её проверяет автовыпуск: флаг курса и срок. */
export type GraduationGroup = Prisma.GroupGetPayload<{
  select: {
    id: true;
    name: true;
    endDate: true;
    course: { select: { id: true; title: true; isLastCourse: true } };
  };
}>;

/** Средний балл студента по **всем** его финализированным неделям (ТЗ 5.8). */
export interface StudentScore {
  studentId: string;
  average: number;
  weeksCount: number;
}

/** Строка выпуска перед записью — балл уже округлён до показанного значения. */
export interface GraduateInput {
  studentId: string;
  points: number | null;
  weeksCount: number;
}

/**
 * Профиль вместе со всеми его членствами — из них выводится статус студента
 * (ТЗ 5.3, правило `deriveStudentStatus` сессии 0014).
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

/**
 * Отбор выпусков — общий для постраничного списка и для счётчиков
 * трудоустройства: два числа на одном экране обязаны считаться по одному
 * набору строк **по определению**, а не по совпадению (приём сессии 0013
 * с выгрузкой состава и 0025 со статистикой оттока).
 *
 * `from`/`to` — уже разобранные границы: `from` включающая, `to` **не**
 * включающая (первое число месяца, следующего за концом периода).
 */
export interface GraduateFilter {
  groupId?: string;
  courseId?: string;
  branchId?: string;
  employment?: GraduateEmployment;
  hasCertificate?: boolean;
  from?: Date;
  to?: Date;
  search?: string;
}

export interface GraduateListParams extends GraduateFilter {
  sort: GraduateSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

/** `undefined` — колонку не менять; значение (включая `null`) — записать. */
export interface GraduateUpdateInput {
  employment?: GraduateEmployment | null;
  workPlace?: string | null;
  graduatedAt?: Date;
}

export interface CertificateInput {
  serial: string;
  issuedAt: Date;
  issuedById: string | null;
}

const whereOf = (filter: GraduateFilter): Prisma.GraduateWhereInput => {
  const group: Prisma.GroupWhereInput = {
    ...(filter.courseId === undefined ? {} : { courseId: filter.courseId }),
    ...(filter.branchId === undefined ? {} : { branchId: filter.branchId }),
  };

  const graduatedAt: Prisma.DateTimeFilter = {
    ...(filter.from === undefined ? {} : { gte: filter.from }),
    ...(filter.to === undefined ? {} : { lt: filter.to }),
  };

  return {
    ...(filter.groupId === undefined ? {} : { groupId: filter.groupId }),
    ...(Object.keys(group).length === 0 ? {} : { group }),
    ...(filter.employment === undefined ? {} : { employment: filter.employment }),
    // «Выдан сертификат» — это наличие серийного номера: отдельный флаг был бы
    // вторым источником истины о том же (комментарий у модели в схеме).
    ...(filter.hasCertificate === undefined
      ? {}
      : { certificateSerial: filter.hasCertificate ? { not: null } : null }),
    ...(Object.keys(graduatedAt).length === 0 ? {} : { graduatedAt }),
    ...(filter.search === undefined
      ? {}
      : {
          OR: [
            { student: { firstName: { contains: filter.search, mode: 'insensitive' } } },
            { student: { lastName: { contains: filter.search, mode: 'insensitive' } } },
            { student: { phone: { contains: filter.search } } },
            { workPlace: { contains: filter.search, mode: 'insensitive' } },
            { certificateSerial: { contains: filter.search, mode: 'insensitive' } },
          ],
        }),
  };
};

/**
 * Доступ к данным выпускников (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — счётчики и дату выпуска считает сервис чистыми
 * функциями из `graduates.ts`.
 */
@Injectable()
export class GraduatesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: GraduateListParams): Promise<{ rows: GraduateRow[]; total: number }> {
    const where = whereOf(params);

    // Ключ `orderBy` собирается ветвлением, а не из строки: вычисляемое поле
    // прошло бы типизацию Prisma и упало бы уже в БД.
    const orderBy: Prisma.GraduateOrderByWithRelationInput[] =
      params.sort === GraduateSortField.Name
        ? [{ student: { lastName: params.order } }, { student: { firstName: params.order } }]
        : params.sort === GraduateSortField.Points
          ? // Выпускник без балла — не «худший»: пустое значение уезжает в конец
            // при любом направлении, как вместимость аудитории (0007) и дата
            // приёма сотрудника (0020).
            [{ points: { sort: params.order, nulls: 'last' } }]
          : [{ graduatedAt: params.order }];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.graduate.findMany({
        where,
        select: GRADUATE_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.graduate.count({ where }),
    ]);

    return { rows, total };
  }

  /**
   * Счётчики трудоустройства (ТЗ 5.11) по **всему** отобранному набору, а не
   * по странице: они один на все страницы и уходят в `meta` — ровно тот случай,
   * ради которого `Paginated` умеет доменные поля (0018, баланс коинов).
   *
   * Агрегат, а не выборка строк: считать нужно только число в каждой группе.
   */
  async countByEmployment(
    filter: GraduateFilter,
  ): Promise<{ employment: GraduateEmployment | null; count: number }[]> {
    const groups = await this.prisma.graduate.groupBy({
      by: ['employment'],
      where: whereOf(filter),
      _count: { _all: true },
    });

    return groups.map(({ employment, _count }) => ({ employment, count: _count._all }));
  }

  findById(id: string): Promise<GraduateRow | null> {
    return this.prisma.graduate.findUnique({ where: { id }, select: GRADUATE_SELECT });
  }

  /**
   * Серийный номер уникален по всему центру: два диплома с одним номером
   * не являются двумя разными документами. Проверка до вставки нужна, чтобы
   * отдать понятный 409 вместо обезличенного P2002.
   */
  findBySerial(serial: string): Promise<{ id: string; certificateSerial: string | null } | null> {
    return this.prisma.graduate.findUnique({
      where: { certificateSerial: serial },
      select: { id: true, certificateSerial: true },
    });
  }

  update(id: string, input: GraduateUpdateInput): Promise<GraduateRow> {
    // `undefined` Prisma пропускает: не переданное поле остаётся прежним.
    return this.prisma.graduate.update({ where: { id }, data: input, select: GRADUATE_SELECT });
  }

  issueCertificate(id: string, input: CertificateInput): Promise<GraduateRow> {
    return this.prisma.graduate.update({
      where: { id },
      data: {
        certificateSerial: input.serial,
        certificateIssuedAt: input.issuedAt,
        certificateIssuedById: input.issuedById,
      },
      select: GRADUATE_SELECT,
    });
  }

  revokeCertificate(id: string): Promise<GraduateRow> {
    return this.prisma.graduate.update({
      where: { id },
      data: { certificateSerial: null, certificateIssuedAt: null, certificateIssuedById: null },
      select: GRADUATE_SELECT,
    });
  }

  // ─────────────────────────── Автовыпуск (ТЗ 5.11) ───────────────────────────

  /** Группа вместе с флагом «Is last course» — на нём держится автовыпуск. */
  findGroupForGraduation(groupId: string): Promise<GraduationGroup | null> {
    return this.prisma.group.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        name: true,
        endDate: true,
        course: { select: { id: true, title: true, isLastCourse: true } },
      },
    });
  }

  /** Кто ещё учится в группе — именно они и выпускаются. */
  async findActiveMemberIds(groupId: string): Promise<string[]> {
    const rows = await this.prisma.groupStudent.findMany({
      where: { groupId, status: GroupStudentStatus.ACTIVE },
      select: { studentId: true },
    });

    return rows.map(({ studentId }) => studentId);
  }

  /**
   * Общий балл выпускников на момент выпуска (ТЗ 5.8: «…→ Points выпускника»).
   *
   * Считается по **всем** финализированным неделям студента, а не только
   * по неделям выпускающей группы: ТЗ 5.8 выводит Points из общего балла,
   * а он по определению один на человека (решение сессии 0019). Фильтр недель
   * берётся общей константой — три места, считающие балл по разным наборам,
   * разошлись бы молча.
   */
  async findScores(studentIds: string[]): Promise<StudentScore[]> {
    if (studentIds.length === 0) return [];

    const groups = await this.prisma.weekResult.groupBy({
      by: ['studentId'],
      where: { studentId: { in: studentIds }, week: FINALIZED_WEEK_FILTER },
      _avg: { sum: true },
      _count: { _all: true },
    });

    return groups.flatMap(({ studentId, _avg, _count }) =>
      _avg.sum === null ? [] : [{ studentId, average: _avg.sum, weeksCount: _count._all }],
    );
  }

  /** Кто из этой группы уже выпущен — на этом держится идемпотентность автовыпуска. */
  async findGraduatedStudentIds(groupId: string): Promise<string[]> {
    const rows = await this.prisma.graduate.findMany({
      where: { groupId },
      select: { studentId: true },
    });

    return rows.map(({ studentId }) => studentId);
  }

  /**
   * Выпуск группы — **одной транзакцией**: строки выпуска и закрытие членств.
   * Половина выпуска (дипломы есть, а студенты числятся учащимися) выглядела бы
   * рабочим состоянием и расходилась бы молча (ТЗ 7).
   *
   * `graduates` — только те, кого ещё не выпускали из этой группы; `memberIds` —
   * весь действующий состав. Списки разные не по недосмотру: вернувшийся
   * в группу выпускник второго диплома не получает (уникальный индекс), но
   * его новое членство закрыть всё равно нужно. `skipDuplicates` остаётся
   * страховкой на гонку двух одновременных закрытий.
   *
   * Членства закрываются `updateMany` с явным `status: ACTIVE` в отборе:
   * уже закрытые строки (уход, перевод) не переписываются — их причина и дата
   * это учебная история (0012), и выпуск не имеет права её затирать.
   */
  graduate(
    groupId: string,
    graduates: GraduateInput[],
    memberIds: string[],
    graduatedAt: Date,
    reason: string,
  ): Promise<GraduateRow[]> {
    return this.prisma.$transaction(async (tx) => {
      if (graduates.length > 0) {
        await tx.graduate.createMany({
          data: graduates.map((graduate) => ({ ...graduate, groupId, graduatedAt })),
          skipDuplicates: true,
        });
      }

      await tx.groupStudent.updateMany({
        where: { groupId, studentId: { in: memberIds }, status: GroupStudentStatus.ACTIVE },
        data: {
          status: GroupStudentStatus.FINISHED,
          statusReason: reason,
          statusChangedAt: graduatedAt,
          // «Ментор на момент ухода» снимается: завершивший курс его
          // не покидал (правило сессии 0025).
          mentorAtLeaveId: null,
        },
      });

      return tx.graduate.findMany({
        where: { groupId, studentId: { in: memberIds } },
        select: GRADUATE_SELECT,
        orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
      });
    });
  }

  /**
   * Профили вместе со **всеми** их членствами — во всех группах, а не только
   * в выпускающей: статус профиля отвечает за человека целиком, и завершение
   * одного курса ничего не значит, пока он учится на другом.
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

  /** Пересчитанные статусы профилей — одной транзакцией. */
  async setStudentStatuses(updates: StudentStatusUpdate[]): Promise<void> {
    if (updates.length === 0) return;

    await this.prisma.$transaction(
      updates.map(({ studentId, status }) =>
        this.prisma.student.update({ where: { id: studentId }, data: { status } }),
      ),
    );
  }

  /** Профиль вызывающего — им подписывается выданный сертификат. `null` без профиля. */
  findEmployeeByAccount(accountId: string): Promise<{ id: string } | null> {
    return this.prisma.employee.findUnique({ where: { accountId }, select: { id: true } });
  }
}
