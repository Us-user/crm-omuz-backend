import { Injectable } from '@nestjs/common';
import type { EmployeeStatus, Gender, Prisma } from '@prisma/client';
import { AccountStatus, EmployeeStatus as Status } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { EmployeeSortField } from './dto';

/**
 * Карточка сотрудника (ТЗ 5.14): профиль, филиал, аккаунт, позиции и группы.
 *
 * Позиции отдаются прямо в строке списка, а не отдельным запросом: экран
 * ТЗ 5.14 показывает их колонкой, а `Administration → Users` (Фаза 2) делает
 * то же самое — вторая форма ответа на тот же вопрос разошлась бы с первой.
 */
const EMPLOYEE_SELECT = {
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
  formerStudentId: true,
  createdAt: true,
  branch: { select: { id: true, name: true } },
  // Хеш пароля в выборку не входит: наружу уходит только то, что показывает карточка.
  account: { select: { id: true, phone: true, email: true, status: true } },
  positions: {
    select: { position: { select: { id: true, name: true, isSystem: true } } },
    orderBy: { position: { name: 'asc' } },
  },
  mentorGroups: {
    select: {
      role: true,
      group: {
        select: { id: true, name: true, courseId: true, course: { select: { title: true } } },
      },
    },
    orderBy: { group: { name: 'asc' } },
  },
} satisfies Prisma.EmployeeSelect;

export type EmployeeRow = Prisma.EmployeeGetPayload<{ select: typeof EMPLOYEE_SELECT }>;

/**
 * Что держит профиль сотрудника: следы его работы, которые нельзя восстановить.
 *
 * Менторство каскадное (сессия 0010), поэтому БД удаление пропустила бы молча —
 * вместе со строкой исчезло бы, кто вёл группу. Финализированные недели, заметки
 * о студентах, начисленные коины и занятия в расписании обнулились бы по
 * `SET NULL`: сами записи остались бы, но без автора.
 */
export type EmployeeDeletionCheck = Prisma.EmployeeGetPayload<{
  select: {
    id: true;
    firstName: true;
    lastName: true;
    accountId: true;
    status: true;
    positions: { select: { position: { select: { id: true; name: true; isSystem: true } } } };
    _count: {
      select: {
        mentorGroups: true;
        mentorSlots: true;
        submittedWeeks: true;
        authoredFeedback: true;
        awardedCoins: true;
        taughtDays: true;
        salaries: true;
      };
    };
  };
}>;

/** Позиция в том виде, в каком её проверяет и отдаёт сервис (ТЗ 3.2). */
export interface PositionRow {
  id: string;
  name: string;
  isSystem: boolean;
}

export interface EmployeeListParams {
  search?: string;
  status?: EmployeeStatus;
  branchId?: string;
  positionId?: string;
  hasAccount?: boolean;
  sort: EmployeeSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

/** Поля профиля, как их пишет сервис: `null` — очистить, значение — записать. */
export interface EmployeeWriteInput {
  firstName: string;
  lastName: string;
  middleName: string | null;
  phone: string;
  birthDate: Date | null;
  gender: Gender | null;
  address: string | null;
  email: string | null;
  telegram: string | null;
  photoUrl: string | null;
  experience: string | null;
  description: string | null;
  branchId: string | null;
  hiredAt: Date | null;
  status?: EmployeeStatus;
}

/** `undefined` — колонку не менять; значение (включая `null`) — записать. */
export type EmployeeUpdateInput = Partial<EmployeeWriteInput>;

/**
 * Доступ к данным сотрудников (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class EmployeesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: EmployeeListParams): Promise<{ rows: EmployeeRow[]; total: number }> {
    const where: Prisma.EmployeeWhereInput = {
      ...(params.status === undefined ? {} : { status: params.status }),
      ...(params.branchId === undefined ? {} : { branchId: params.branchId }),
      ...(params.positionId === undefined
        ? {}
        : { positions: { some: { positionId: params.positionId } } }),
      ...(params.hasAccount === undefined
        ? {}
        : { accountId: params.hasAccount ? { not: null } : null }),
      ...(params.search === undefined
        ? {}
        : {
            OR: [
              { firstName: { contains: params.search, mode: 'insensitive' } },
              { lastName: { contains: params.search, mode: 'insensitive' } },
              { middleName: { contains: params.search, mode: 'insensitive' } },
              { phone: { contains: params.search } },
              { email: { contains: params.search, mode: 'insensitive' } },
            ],
          }),
    };

    // Ключ `orderBy` собирается ветвлением, а не из строки: вычисляемое поле
    // прошло бы типизацию Prisma и упало бы уже в БД.
    const orderBy = orderByOf(params.sort, params.order);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.employee.findMany({
        where,
        select: EMPLOYEE_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.employee.count({ where }),
    ]);

    return { rows, total };
  }

  findById(id: string): Promise<EmployeeRow | null> {
    return this.prisma.employee.findUnique({ where: { id }, select: EMPLOYEE_SELECT });
  }

  /**
   * Телефон сотрудника уникален — проверка до вставки, чтобы отдать понятный 409
   * вместо обезличенного «запись с такими значениями уже существует» (P2002).
   */
  findByPhone(phone: string): Promise<{ id: string; firstName: string; lastName: string } | null> {
    return this.prisma.employee.findUnique({
      where: { phone },
      select: { id: true, firstName: true, lastName: true },
    });
  }

  /** Существует ли филиал из тела запроса: несуществующий даёт 422, а не ошибку внешнего ключа. */
  findBranch(id: string): Promise<{ id: string } | null> {
    return this.prisma.branch.findUnique({ where: { id }, select: { id: true } });
  }

  /** Позиции из тела запроса: пришедшие лишними перечисляются в отказе. */
  findPositionsByIds(ids: readonly string[]): Promise<PositionRow[]> {
    if (ids.length === 0) return Promise.resolve([]);

    return this.prisma.position.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, name: true, isSystem: true },
    });
  }

  /**
   * Сколько сотрудников занимает позицию — на этом держится правило
   * «последнего `Director` не разжаловать» (сессия 0006). Здесь оно нужно ещё
   * и при увольнении с удалением: закрытый вход последнего руководителя
   * запирает систему так же надёжно, как снятая позиция.
   */
  countPositionHolders(positionId: string, exceptEmployeeId?: string): Promise<number> {
    return this.prisma.employeePosition.count({
      where: {
        positionId,
        ...(exceptEmployeeId === undefined ? {} : { employeeId: { not: exceptEmployeeId } }),
        // Уволенный руководитель системе уже не поможет: вход ему закрыт,
        // поэтому в «сколько осталось Director'ов» он не считается.
        employee: { status: Status.ACTIVE },
      },
    });
  }

  /**
   * Что мешает удалить профиль: следы работы сотрудника. Считаются отдельными
   * счётчиками, чтобы отказ называл причину, а не отсылал к внешнему ключу.
   */
  findForDeletion(id: string): Promise<EmployeeDeletionCheck | null> {
    return this.prisma.employee.findUnique({
      where: { id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        accountId: true,
        status: true,
        positions: { select: { position: { select: { id: true, name: true, isSystem: true } } } },
        _count: {
          select: {
            mentorGroups: true,
            mentorSlots: true,
            submittedWeeks: true,
            authoredFeedback: true,
            awardedCoins: true,
            // Проведённые занятия и расчёты зарплаты (0032): первые — след
            // работы, вторые — деньги, и уносить их каскадом нельзя молча.
            taughtDays: true,
            salaries: true,
          },
        },
      },
    });
  }

  /**
   * Создание профиля вместе с позициями, одной транзакцией: сотрудник, заведённый
   * без обещанных ролей, — состояние хуже, чем отказ целиком (ТЗ 7).
   */
  async create(input: EmployeeWriteInput, positionIds?: readonly string[]): Promise<EmployeeRow> {
    return this.prisma.employee.create({
      data: {
        ...input,
        ...(positionIds === undefined || positionIds.length === 0
          ? {}
          : { positions: { create: positionIds.map((positionId) => ({ positionId })) } }),
      },
      select: EMPLOYEE_SELECT,
    });
  }

  /**
   * Правка профиля, замена набора позиций и согласование статуса аккаунта —
   * одной транзакцией (ТЗ 7).
   *
   * Три вещи вместе не из аккуратности: `INACTIVE` по решению этой сессии
   * означает и закрытый вход, а частичное применение дало бы уволенного
   * сотрудника, который продолжает работать в системе, — состояние, которое
   * выглядит рабочим и расходится молча (та же причина, что у блокировки
   * студента в сессии 0015).
   *
   * @returns профиль и число погашенных сессий.
   */
  async update(
    id: string,
    input: EmployeeUpdateInput,
    positionIds: readonly string[] | undefined,
    accountStatus: AccountStatus | undefined,
  ): Promise<{ employee: EmployeeRow; revokedSessions: number }> {
    return this.prisma.$transaction(async (tx) => {
      // `undefined` Prisma пропускает: не переданное поле остаётся прежним.
      const employee = await tx.employee.update({ where: { id }, data: input });

      if (positionIds !== undefined) {
        await tx.employeePosition.deleteMany({ where: { employeeId: id } });
        if (positionIds.length > 0) {
          await tx.employeePosition.createMany({
            data: positionIds.map((positionId) => ({ employeeId: id, positionId })),
          });
        }
      }

      let revokedSessions = 0;

      if (accountStatus !== undefined && employee.accountId !== null) {
        await tx.account.update({
          where: { id: employee.accountId },
          data: { status: accountStatus },
        });

        // Тип и права читаются из БД на каждый запрос, но сам факт входа —
        // нет: без гашения сессий уволенный обновлял бы токены ещё две недели.
        if (accountStatus === AccountStatus.BLOCKED) {
          const { count } = await tx.session.updateMany({
            where: { accountId: employee.accountId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          revokedSessions = count;
        }
      }

      const row = await tx.employee.findUniqueOrThrow({ where: { id }, select: EMPLOYEE_SELECT });

      return { employee: row, revokedSessions };
    });
  }

  /**
   * Удаление профиля вместе с его аккаунтом, одной транзакцией.
   *
   * Аккаунт уходит следом по ТЗ 3.1: к аккаунту привязан профиль Student ИЛИ
   * Employee, и оставленный логин без профиля — это вход в систему от имени
   * человека, которого в ней больше нет. Сессии и коды сброса пароля унесёт
   * каскад со стороны `Account`. То же решение, что у студента (сессия 0014).
   */
  async delete(id: string, accountId: string | null): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.employee.delete({ where: { id } });

      if (accountId !== null) {
        await tx.account.delete({ where: { id: accountId } });
      }
    });
  }
}

const orderByOf = (
  sort: EmployeeSortField,
  order: SortOrder,
): Prisma.EmployeeOrderByWithRelationInput[] => {
  switch (sort) {
    case EmployeeSortField.CreatedAt:
      return [{ createdAt: order }];
    // Сотрудник без даты приёма — не «самый ранний»: пустое значение уходит
    // в конец при любом направлении (то же, что с вместимостью в сессии 0007).
    case EmployeeSortField.HiredAt:
      return [{ hiredAt: { sort: order, nulls: 'last' } }];
    default:
      return [{ lastName: order }, { firstName: order }];
  }
};
