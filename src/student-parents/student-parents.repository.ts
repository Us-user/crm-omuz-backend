import { Injectable } from '@nestjs/common';
import type { ParentRelation, Prisma } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { StudentParentSortField } from './dto';

/**
 * Связка вместе с записью родителя: список читают контактами, а не
 * идентификаторами. `_count.students` — сколько детей у родителя в центре:
 * по нему видно, что запись общая и правка тронет чужие карточки.
 */
const PARENT_LINK_SELECT = {
  relation: true,
  createdAt: true,
  parent: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      email: true,
      telegram: true,
      notes: true,
      _count: { select: { students: true } },
    },
  },
} satisfies Prisma.StudentParentSelect;

export type ParentLinkRow = Prisma.StudentParentGetPayload<{ select: typeof PARENT_LINK_SELECT }>;

/** Поля самой записи родителя — то, что общее для всех его детей. */
const PARENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  email: true,
  telegram: true,
  notes: true,
} satisfies Prisma.ParentSelect;

export type ParentRow = Prisma.ParentGetPayload<{ select: typeof PARENT_SELECT }>;

export interface ParentListParams {
  studentId: string;
  search?: string;
  relation?: ParentRelation;
  sort: StudentParentSortField;
  order: SortOrder;
  skip: number;
  take: number;
}

/** Поля записи родителя, как их пишет сервис: `null` — очистить, значение — записать. */
export interface ParentWriteInput {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string;
  email?: string | null;
  telegram?: string | null;
  notes?: string | null;
}

export interface CreateParentInput {
  studentId: string;
  parent: ParentWriteInput & { phone: string };
  relation: ParentRelation | null;
}

export interface LinkParentInput {
  studentId: string;
  parentId: string;
  relation: ParentRelation | null;
  /**
   * Чем дозаполнить пустые поля уже существующей записи. Заполненные поля
   * не трогаются: перезапись молча меняла бы карточку другого ребёнка.
   */
  fill: ParentWriteInput;
}

export interface UpdateParentInput {
  studentId: string;
  parentId: string;
  parent: ParentWriteInput;
  /** `undefined` — родство не менять, `null` — снять. */
  relation?: ParentRelation | null;
}

export interface UnlinkParentResult {
  /** Осталась ли запись родителя в системе: без детей она удаляется. */
  parentDeleted: boolean;
}

/**
 * Доступ к данным родителей (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class StudentParentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: ParentListParams): Promise<{ rows: ParentLinkRow[]; total: number }> {
    const where: Prisma.StudentParentWhereInput = {
      studentId: params.studentId,
      ...(params.relation === undefined ? {} : { relation: params.relation }),
      ...(params.search === undefined
        ? {}
        : {
            parent: {
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
    const orderBy: Prisma.StudentParentOrderByWithRelationInput[] =
      params.sort === StudentParentSortField.Name
        ? [{ parent: { lastName: params.order } }, { parent: { firstName: params.order } }]
        : [{ createdAt: params.order }];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.studentParent.findMany({
        where,
        select: PARENT_LINK_SELECT,
        orderBy,
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.studentParent.count({ where }),
    ]);

    return { rows, total };
  }

  /** Есть ли такой студент: родители несуществующего человека — это 404, а не пустой список. */
  findStudent(id: string): Promise<{ id: string } | null> {
    return this.prisma.student.findUnique({ where: { id }, select: { id: true } });
  }

  /**
   * Родитель по телефону — на этом держится вся модель: номер уникален, и по нему
   * второй ребёнок привязывается к уже заведённой записи вместо её копии.
   */
  findParentByPhone(phone: string): Promise<ParentRow | null> {
    return this.prisma.parent.findUnique({ where: { phone }, select: PARENT_SELECT });
  }

  /**
   * Связка ищется вместе со студентом из пути, а не по одному `parentId`: иначе
   * адрес `/students/A/parents/{id}` правил бы родителя студента B — вложенность
   * выглядела бы защитой, не будучи ею (то же правило, что у уроков курса).
   */
  findLink(studentId: string, parentId: string): Promise<ParentLinkRow | null> {
    return this.prisma.studentParent.findUnique({
      where: { studentId_parentId: { studentId, parentId } },
      select: PARENT_LINK_SELECT,
    });
  }

  /**
   * Новый родитель вместе со связкой — вложенной записью, то есть одной
   * транзакцией. Студент подключается через `connect`, а не идентификатором
   * колонки: вложенный `create` родителя и «сырой» `studentId` относятся
   * к разным формам записи Prisma и вместе не типизируются.
   */
  create(input: CreateParentInput): Promise<ParentLinkRow> {
    return this.prisma.studentParent.create({
      data: {
        student: { connect: { id: input.studentId } },
        relation: input.relation,
        parent: { create: input.parent },
      },
      select: PARENT_LINK_SELECT,
    });
  }

  /**
   * Привязка существующего родителя. Дозаполнение пустых полей идёт той же
   * транзакцией: иначе связка появилась бы без данных, которые оператор
   * только что ввёл.
   */
  async link(input: LinkParentInput): Promise<ParentLinkRow> {
    return this.prisma.$transaction(async (tx) => {
      if (Object.keys(input.fill).length > 0) {
        await tx.parent.update({ where: { id: input.parentId }, data: input.fill });
      }

      return tx.studentParent.create({
        data: {
          studentId: input.studentId,
          parentId: input.parentId,
          relation: input.relation,
        },
        select: PARENT_LINK_SELECT,
      });
    });
  }

  /**
   * Правка записи родителя и степени родства одной транзакцией: половина
   * применённых изменений выглядела бы сохранённой формой, которая молча
   * разошлась с тем, что видит оператор.
   */
  async update(input: UpdateParentInput): Promise<ParentLinkRow> {
    return this.prisma.$transaction(async (tx) => {
      if (Object.keys(input.parent).length > 0) {
        await tx.parent.update({ where: { id: input.parentId }, data: input.parent });
      }

      if (input.relation !== undefined) {
        await tx.studentParent.update({
          where: { studentId_parentId: { studentId: input.studentId, parentId: input.parentId } },
          data: { relation: input.relation },
        });
      }

      return tx.studentParent.findUniqueOrThrow({
        where: { studentId_parentId: { studentId: input.studentId, parentId: input.parentId } },
        select: PARENT_LINK_SELECT,
      });
    });
  }

  /**
   * Отвязка родителя. Если детей в центре у него не осталось, запись удаляется
   * целиком: отдельного справочника родителей нет, и такая строка стала бы
   * недостижимой — её нельзя ни найти, ни исправить, ни удалить.
   */
  async unlink(studentId: string, parentId: string): Promise<UnlinkParentResult> {
    return this.prisma.$transaction(async (tx) => {
      await tx.studentParent.delete({
        where: { studentId_parentId: { studentId, parentId } },
      });

      const children = await tx.studentParent.count({ where: { parentId } });
      if (children > 0) {
        return { parentDeleted: false };
      }

      await tx.parent.delete({ where: { id: parentId } });

      return { parentDeleted: true };
    });
  }
}
