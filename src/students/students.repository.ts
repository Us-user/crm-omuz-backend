import { Injectable } from '@nestjs/common';
import type { Gender, Prisma, StudentStatus } from '@prisma/client';
import { AccountType, GroupStudentStatus } from '@prisma/client';

import type { SortOrder } from '../common';
// Прямым путём, а не через barrel `../performance`: оттуда пришли бы ещё сервис
// и репозиторий успеваемости, которые студентам не нужны (правило сессии 0007).
import { FINALIZED_WEEK_FILTER, RANKED_STUDENT_FILTER } from '../performance/performance';
import { PrismaService } from '../prisma/prisma.service';
import { StudentSortField } from './dto';

/** Всё, что нужно знать о студенте, чтобы решить и выполнить перевод в сотрудники. */
const STUDENT_PROMOTION_SELECT = {
  id: true,
  accountId: true,
  firstName: true,
  lastName: true,
  birthDate: true,
  gender: true,
  address: true,
  email: true,
  phone: true,
  telegram: true,
  photoUrl: true,
  branchId: true,
  promotedEmployee: { select: { id: true } },
  account: { select: { id: true, phone: true, email: true, type: true, status: true } },
} satisfies Prisma.StudentSelect;

export type StudentForPromotion = Prisma.StudentGetPayload<{
  select: typeof STUDENT_PROMOTION_SELECT;
}>;

const EMPLOYEE_SELECT = {
  id: true,
  accountId: true,
  formerStudentId: true,
  firstName: true,
  lastName: true,
  middleName: true,
  phone: true,
  email: true,
  status: true,
  hiredAt: true,
} satisfies Prisma.EmployeeSelect;

export type PromotedEmployee = Prisma.EmployeeGetPayload<{ select: typeof EMPLOYEE_SELECT }>;

const ACCOUNT_SELECT = {
  id: true,
  phone: true,
  email: true,
  type: true,
  status: true,
} satisfies Prisma.AccountSelect;

export type PromotedAccount = Prisma.AccountGetPayload<{ select: typeof ACCOUNT_SELECT }>;

/** Поля профиля сотрудника, собранные сервисом из профиля студента и тела запроса. */
export interface PromotedEmployeeInput {
  firstName: string;
  lastName: string;
  middleName?: string;
  birthDate: Date | null;
  gender: Gender | null;
  address: string | null;
  email: string | null;
  phone: string;
  telegram: string | null;
  photoUrl: string | null;
  /** Филиал переезжает вместе с человеком (ТЗ 3.3): место работы у него то же. */
  branchId: string | null;
  experience?: string;
  description?: string;
  hiredAt: Date;
}

export interface PromoteStudentInput {
  studentId: string;
  /** Аккаунт студента, если он есть: профиль мог быть заведён администратором без логина. */
  accountId: string | null;
  employee: PromotedEmployeeInput;
}

export interface PromoteStudentResult {
  employee: PromotedEmployee;
  account: PromotedAccount | null;
  revokedSessions: number;
}

/** Карточка студента (ТЗ 5.3): профиль, филиал, аккаунт и действующие группы. */
const STUDENT_SELECT = {
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
  notes: true,
  status: true,
  createdAt: true,
  branch: { select: { id: true, name: true } },
  // Родители (ТЗ 4) — контакты прямо в карточке: раньше на этом месте была
  // колонка `parentPhone`, и убрать её, ничего не отдав взамен, значило бы
  // потерять телефон родителя из строки списка.
  parents: {
    select: {
      relation: true,
      parent: { select: { id: true, firstName: true, lastName: true, phone: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
  // Хеш пароля в выборку не входит: наружу уходит только то, что показывает карточка.
  account: { select: { id: true, phone: true, email: true, status: true } },
  // Только действующие членства: закрытые — это история, и в строке списка
  // «где учится сейчас» они дали бы неверный ответ. Их число отдаёт `_count`.
  groups: {
    where: { status: GroupStudentStatus.ACTIVE },
    select: {
      group: {
        select: { id: true, name: true, courseId: true, course: { select: { title: true } } },
      },
    },
    orderBy: { group: { name: 'asc' } },
  },
  _count: { select: { groups: true } },
} satisfies Prisma.StudentSelect;

export type StudentRow = Prisma.StudentGetPayload<{ select: typeof STUDENT_SELECT }>;

/** Что мешает удалить профиль: учебная история и перевод в сотрудники. */
export type StudentDeletionCheck = Prisma.StudentGetPayload<{
  select: {
    id: true;
    firstName: true;
    lastName: true;
    accountId: true;
    promotedEmployee: { select: { id: true } };
    leadOrigin: { select: { id: true } };
    _count: {
      select: {
        groups: true;
        journalEntries: true;
        coinTransactions: true;
        monthlyWins: true;
        graduations: true;
      };
    };
  };
}>;

export interface StudentListParams {
  search?: string;
  status?: StudentStatus;
  branchId?: string;
  groupId?: string;
  courseId?: string;
  hasAccount?: boolean;
  sort: StudentSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

/** Поля профиля, как их пишет сервис: `null` — очистить, значение — записать. */
export interface StudentWriteInput {
  firstName: string;
  lastName: string;
  phone: string;
  birthDate: Date | null;
  gender: Gender | null;
  address: string | null;
  email: string | null;
  extraPhones: string[];
  telegram: string | null;
  photoUrl: string | null;
  notes: string | null;
  branchId: string | null;
  status?: StudentStatus;
}

/** `undefined` — колонку не менять; значение (включая `null`) — записать. */
export type StudentUpdateInput = Partial<StudentWriteInput>;

/** Общий балл одного студента (ТЗ 5.8) — из него выводятся категория и корона. */
export interface StudentScoreRow {
  studentId: string;
  /** Неокруглённое среднее: по нему сравнивается корона (см. `roundScore`). */
  average: number;
  weeksCount: number;
}

/**
 * Доступ к данным студентов (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class StudentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: StudentListParams): Promise<{ rows: StudentRow[]; total: number }> {
    const where: Prisma.StudentWhereInput = {
      ...(params.status === undefined ? {} : { status: params.status }),
      ...(params.branchId === undefined ? {} : { branchId: params.branchId }),
      ...(params.hasAccount === undefined
        ? {}
        : { accountId: params.hasAccount ? { not: null } : null }),
      // Фильтры «Group» и «Course» (ТЗ 5.3) смотрят только на действующие
      // членства: «студенты группы» — это те, кто в ней учится, а не все,
      // кто когда-либо в ней числился.
      ...(params.groupId === undefined
        ? {}
        : { groups: { some: { groupId: params.groupId, status: GroupStudentStatus.ACTIVE } } }),
      ...(params.courseId === undefined
        ? {}
        : {
            groups: {
              some: { status: GroupStudentStatus.ACTIVE, group: { courseId: params.courseId } },
            },
          }),
      ...(params.search === undefined
        ? {}
        : {
            OR: [
              { firstName: { contains: params.search, mode: 'insensitive' } },
              { lastName: { contains: params.search, mode: 'insensitive' } },
              { phone: { contains: params.search } },
              { email: { contains: params.search, mode: 'insensitive' } },
            ],
          }),
    };

    // Ключ `orderBy` собирается ветвлением, а не из строки: вычисляемое поле
    // прошло бы типизацию Prisma и упало бы уже в БД.
    const orderBy: Prisma.StudentOrderByWithRelationInput[] =
      params.sort === StudentSortField.CreatedAt
        ? [{ createdAt: params.order }]
        : [{ lastName: params.order }, { firstName: params.order }];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.student.findMany({
        where,
        select: STUDENT_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.student.count({ where }),
    ]);

    return { rows, total };
  }

  findById(id: string): Promise<StudentRow | null> {
    return this.prisma.student.findUnique({ where: { id }, select: STUDENT_SELECT });
  }

  /**
   * Общий балл студентов страницы (ТЗ 5.8) — на нём держатся категория
   * активности (ТЗ 5.5) и корона (ТЗ 5.3) в строке списка.
   *
   * Считается по **финализированным** неделям: набор задаётся общей константой,
   * а не переписанным здесь условием, — три места с разными наборами недель
   * разошлись бы молча. Студенты без единой закрытой недели в ответ не попадают:
   * балла у них нет, и ноль записал бы их в Black list ни за что.
   */
  async aggregateScores(studentIds: string[]): Promise<StudentScoreRow[]> {
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

  /**
   * Наибольший общий балл среди участников рейтинга — им помечается корона
   * (ТЗ 5.3: «топ-студент»). В рейтинг идут только те, кто учится сейчас
   * (решение сессии 0019), иначе корона навсегда осталась бы у выпускника.
   *
   * `null` — в центре нет ни одной финализированной недели, и короны нет ни у кого.
   */
  async findTopAverage(): Promise<number | null> {
    const [top] = await this.prisma.weekResult.groupBy({
      by: ['studentId'],
      where: { week: FINALIZED_WEEK_FILTER, student: RANKED_STUDENT_FILTER },
      _avg: { sum: true },
      orderBy: { _avg: { sum: 'desc' } },
      take: 1,
    });

    return top?._avg.sum ?? null;
  }

  /**
   * Телефон студента уникален — проверка до вставки, чтобы отдать понятный 409
   * вместо обезличенного «запись с такими значениями уже существует» (P2002).
   */
  findByPhone(phone: string): Promise<{ id: string; firstName: string; lastName: string } | null> {
    return this.prisma.student.findUnique({
      where: { phone },
      select: { id: true, firstName: true, lastName: true },
    });
  }

  /** Существует ли филиал из тела запроса: несуществующий даёт 422, а не ошибку внешнего ключа. */
  findBranch(id: string): Promise<{ id: string } | null> {
    return this.prisma.branch.findUnique({ where: { id }, select: { id: true } });
  }

  /**
   * Что держит профиль: членства в группах, отметки в журнале, начисленные
   * коины и перевод в сотрудники. Журнал и коины считаются отдельно от членств
   * (ТЗ 5.8, 5.9): отметки ссылаются на профиль, а не на членство, поэтому
   * у исключённого из состава студента баллы остаются, и удаление профиля
   * унесло бы их каскадом.
   */
  findForDeletion(id: string): Promise<StudentDeletionCheck | null> {
    return this.prisma.student.findUnique({
      where: { id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        accountId: true,
        promotedEmployee: { select: { id: true } },
        // Лид, из которого завёлся профиль (ТЗ 5.7). Связь 1:1, поэтому
        // `_count` к ней неприменим — берётся сама ссылка.
        leadOrigin: { select: { id: true } },
        _count: {
          select: {
            groups: true,
            journalEntries: true,
            coinTransactions: true,
            // Победы в месячном рейтинге держат профиль так же, как журнал
            // и коины: снимок месяца не должен меняться задним числом
            // (внешний ключ и так стоит `RESTRICT`, но причину отказа
            // наружу должен называть сервис, а не ошибка связи).
            monthlyWins: true,
            // Выпуски (ТЗ 5.11) — по той же причине: вместе с профилем исчезли
            // бы факт окончания курса и выданный сертификат.
            graduations: true,
          },
        },
      },
    });
  }

  create(input: StudentWriteInput): Promise<StudentRow> {
    return this.prisma.student.create({ data: input, select: STUDENT_SELECT });
  }

  update(id: string, input: StudentUpdateInput): Promise<StudentRow> {
    // `undefined` Prisma пропускает: не переданное поле остаётся прежним.
    return this.prisma.student.update({ where: { id }, data: input, select: STUDENT_SELECT });
  }

  /**
   * Удаление профиля вместе с его аккаунтом, одной транзакцией.
   *
   * Аккаунт уходит следом не из аккуратности, а по ТЗ 3.1: к аккаунту привязан
   * профиль Student ИЛИ Employee. Оставленный логин без профиля — это вход
   * в систему от имени человека, которого в ней больше нет. Сессии и коды
   * сброса пароля унесёт каскад со стороны `Account`.
   */
  async delete(id: string, accountId: string | null): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.student.delete({ where: { id } });

      if (accountId !== null) {
        await tx.account.delete({ where: { id: accountId } });
      }
    });
  }

  findForPromotion(id: string): Promise<StudentForPromotion | null> {
    return this.prisma.student.findUnique({ where: { id }, select: STUDENT_PROMOTION_SELECT });
  }

  /** Телефон в таблице сотрудников уникален — проверка до вставки, чтобы отдать понятный 409. */
  findEmployeeByPhone(phone: string): Promise<{ id: string } | null> {
    return this.prisma.employee.findUnique({ where: { phone }, select: { id: true } });
  }

  /**
   * Перевод Студент → Сотрудник одной транзакцией (ТЗ 3.1, 7).
   *
   * Частичное применение оставило бы аккаунт без профиля или два профиля на одном
   * аккаунте — оба состояния запрещены ТЗ 3.1 и чинились бы вручную.
   *
   * @returns созданный профиль сотрудника, обновлённый аккаунт и число погашенных сессий.
   */
  async promoteToEmployee(input: PromoteStudentInput): Promise<PromoteStudentResult> {
    return this.prisma.$transaction(async (tx) => {
      // Профиль студента остаётся со всей учебной историей, но отвязывается от
      // аккаунта: ТЗ 3.1 — к аккаунту привязан Student ИЛИ Employee, не одновременно.
      if (input.accountId !== null) {
        await tx.student.update({ where: { id: input.studentId }, data: { accountId: null } });
      }

      const employee = await tx.employee.create({
        data: {
          ...input.employee,
          accountId: input.accountId,
          formerStudentId: input.studentId,
        },
        select: EMPLOYEE_SELECT,
      });

      if (input.accountId === null) {
        return { employee, account: null, revokedSessions: 0 };
      }

      // Логин (`phone`), email и хеш пароля не трогаются — меняется только тип (ТЗ 3.1).
      const account = await tx.account.update({
        where: { id: input.accountId },
        data: { type: AccountType.EMPLOYEE },
        select: ACCOUNT_SELECT,
      });

      // Тип аккаунта зашит в access-токен, а стратегия не ходит в БД: без гашения
      // сессий бывший студент до часа ходил бы с токеном типа STUDENT.
      const { count } = await tx.session.updateMany({
        where: { accountId: input.accountId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      return { employee, account, revokedSessions: count };
    });
  }
}
