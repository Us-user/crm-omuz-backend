import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { Paginated } from '../common';
import type { CreateFeedbackDto, FeedbackDeletedDto, FeedbackDto, FeedbackQueryDto } from './dto';
import type { FeedbackRow } from './student-feedback.repository';
import { StudentFeedbackRepository } from './student-feedback.repository';

/** Сколько символов заметки возвращается в ответе на удаление. */
const DELETED_PREVIEW_LENGTH = 80;

/**
 * Обратная связь по студенту (ТЗ 5.3: карточка — Feedback / Edit / Block / Delete).
 *
 * Заметка сотрудника о студенте: наблюдение ментора, разговор с родителями,
 * причина пропусков. Автор берётся из токена, а не из тела запроса: подписаться
 * чужим именем не должно быть возможно даже по ошибке.
 *
 * Правки заметки нет — только добавление и удаление. Исправленное наблюдение
 * задним числом перестаёт быть тем, что видел автор в тот день, а история
 * правок потребовала бы своей таблицы ради ТЗ, которое их не просит.
 */
@Injectable()
export class StudentFeedbackService {
  private readonly logger = new Logger(StudentFeedbackService.name);

  constructor(private readonly repository: StudentFeedbackRepository) {}

  async findAll(studentId: string, query: FeedbackQueryDto): Promise<Paginated<FeedbackDto>> {
    await this.requireStudent(studentId);

    const { rows, total } = await this.repository.findMany({
      studentId,
      search: query.search,
      authorId: query.authorId,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toDto), total, query);
  }

  async create(
    studentId: string,
    dto: CreateFeedbackDto,
    actorAccountId: string,
  ): Promise<FeedbackDto> {
    await this.requireStudent(studentId);

    // Профиля сотрудника может не быть, если аккаунт заведён в обход обычного
    // пути: заметку это не отменяет — она про студента, автор лишь подпись.
    const author = await this.repository.findEmployeeByAccount(actorAccountId);

    const feedback = await this.repository.create({
      studentId,
      authorId: author?.id ?? null,
      text: dto.text,
    });

    this.logger.log(`Добавлена заметка о студенте ${studentId}: ${feedback.id}`);

    return toDto(feedback);
  }

  async remove(studentId: string, id: string): Promise<FeedbackDeletedDto> {
    await this.requireStudent(studentId);

    const feedback = await this.repository.findOne(studentId, id);
    if (!feedback) {
      throw new NotFoundException('Заметка не найдена у этого студента');
    }

    await this.repository.delete(id);

    this.logger.log(`Удалена заметка о студенте ${studentId}: ${id}`);

    return { id, text: preview(feedback.text) };
  }

  /**
   * Студент проверяется отдельным запросом, хотя заметки и так отбираются
   * по `studentId`: иначе опечатка в идентификаторе выглядела бы как студент
   * без единой заметки (то же решение, что с курсом в силлабусе).
   */
  private async requireStudent(id: string): Promise<void> {
    const student = await this.repository.findStudent(id);
    if (!student) {
      throw new NotFoundException('Студент не найден');
    }
  }
}

const preview = (text: string): string =>
  text.length <= DELETED_PREVIEW_LENGTH ? text : `${text.slice(0, DELETED_PREVIEW_LENGTH)}…`;

const toDto = (row: FeedbackRow): FeedbackDto => ({
  id: row.id,
  text: row.text,
  author: row.author,
  createdAt: row.createdAt.toISOString(),
});
