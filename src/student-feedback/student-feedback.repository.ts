import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { SortOrder } from '../common';
import { PrismaService } from '../prisma/prisma.service';

/** Заметка вместе с автором: список читают именами, а не идентификаторами. */
const FEEDBACK_SELECT = {
  id: true,
  text: true,
  createdAt: true,
  author: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.FeedbackSelect;

export type FeedbackRow = Prisma.FeedbackGetPayload<{ select: typeof FEEDBACK_SELECT }>;

export interface FeedbackListParams {
  studentId: string;
  search?: string;
  authorId?: string;
  order: SortOrder;
  skip: number;
  take: number;
}

export interface CreateFeedbackInput {
  studentId: string;
  /** Сотрудник, оставивший заметку; `null` — у аккаунта нет профиля сотрудника. */
  authorId: string | null;
  text: string;
}

/**
 * Доступ к данным обратной связи (`Controller → Service → Repository`).
 * Бизнес-правил здесь нет — только запросы Prisma.
 */
@Injectable()
export class StudentFeedbackRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(params: FeedbackListParams): Promise<{ rows: FeedbackRow[]; total: number }> {
    const where: Prisma.FeedbackWhereInput = {
      studentId: params.studentId,
      ...(params.authorId === undefined ? {} : { authorId: params.authorId }),
      ...(params.search === undefined
        ? {}
        : { text: { contains: params.search, mode: 'insensitive' } }),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.feedback.findMany({
        where,
        select: FEEDBACK_SELECT,
        orderBy: { createdAt: params.order },
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.feedback.count({ where }),
    ]);

    return { rows, total };
  }

  /** Есть ли такой студент: заметка о несуществующем человеке — это 404, а не пустой список. */
  findStudent(id: string): Promise<{ id: string } | null> {
    return this.prisma.student.findUnique({ where: { id }, select: { id: true } });
  }

  /** Профиль сотрудника по его аккаунту — автор заметки (ТЗ 5.14: логин опционален). */
  findEmployeeByAccount(accountId: string): Promise<{ id: string } | null> {
    return this.prisma.employee.findUnique({ where: { accountId }, select: { id: true } });
  }

  /**
   * Заметка ищется вместе со студентом из пути, а не по одному `id`: иначе адрес
   * `/students/A/feedback/{id}` удалял бы заметку о студенте B — вложенность
   * выглядела бы защитой, не будучи ею (то же правило, что у уроков курса).
   */
  findOne(studentId: string, id: string): Promise<FeedbackRow | null> {
    return this.prisma.feedback.findFirst({ where: { id, studentId }, select: FEEDBACK_SELECT });
  }

  create(input: CreateFeedbackInput): Promise<FeedbackRow> {
    return this.prisma.feedback.create({ data: input, select: FEEDBACK_SELECT });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.feedback.delete({ where: { id } });
  }
}
