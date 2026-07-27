import { NotFoundException } from '@nestjs/common';

import { SortOrder } from '../common';
import { FeedbackQueryDto } from './dto';
import type { FeedbackRow, StudentFeedbackRepository } from './student-feedback.repository';
import { StudentFeedbackService } from './student-feedback.service';

const STUDENT_ID = '11111111-1111-1111-1111-111111111111';
const FEEDBACK_ID = '22222222-2222-2222-2222-222222222222';
const AUTHOR_ID = '33333333-3333-3333-3333-333333333333';
const ACTOR_ACCOUNT_ID = '44444444-4444-4444-4444-444444444444';

const row = (overrides: Partial<FeedbackRow> = {}): FeedbackRow => ({
  id: FEEDBACK_ID,
  text: 'Пропустил две недели по болезни, догнал программу самостоятельно.',
  createdAt: new Date('2026-07-28T09:30:00.000Z'),
  author: { id: AUTHOR_ID, firstName: 'Фаррух', lastName: 'Раҳимов' },
  ...overrides,
});

// Настоящий экземпляр DTO, а не литерал: `skip`/`take` — вычисляемые геттеры.
const query = (overrides: Partial<FeedbackQueryDto> = {}): FeedbackQueryDto =>
  Object.assign(new FeedbackQueryDto(), overrides);

describe('StudentFeedbackService', () => {
  let repository: jest.Mocked<
    Pick<
      StudentFeedbackRepository,
      'findMany' | 'findStudent' | 'findEmployeeByAccount' | 'findOne' | 'create' | 'delete'
    >
  >;
  let service: StudentFeedbackService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findStudent: jest.fn().mockResolvedValue({ id: STUDENT_ID }),
      findEmployeeByAccount: jest.fn().mockResolvedValue({ id: AUTHOR_ID }),
      findOne: jest.fn().mockResolvedValue(row()),
      create: jest.fn().mockImplementation(({ text }: { text: string }) => {
        return Promise.resolve(row({ text }));
      }),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    service = new StudentFeedbackService(repository as unknown as StudentFeedbackRepository);
  });

  describe('Лента', () => {
    it('отдаёт заметку с автором и временем', async () => {
      const result = await service.findAll(STUDENT_ID, query());

      expect(result.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(result.items[0]).toMatchObject({
        id: FEEDBACK_ID,
        author: { id: AUTHOR_ID, lastName: 'Раҳимов' },
        createdAt: '2026-07-28T09:30:00.000Z',
      });
    });

    it('по умолчанию свежие сверху', async () => {
      await service.findAll(STUDENT_ID, query());

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ order: SortOrder.Desc }),
      );
    });

    it('передаёт окно страницы, автора и поиск', async () => {
      await service.findAll(
        STUDENT_ID,
        query({ page: 2, limit: 5, search: 'болезн', authorId: AUTHOR_ID }),
      );

      expect(repository.findMany).toHaveBeenCalledWith({
        studentId: STUDENT_ID,
        search: 'болезн',
        authorId: AUTHOR_ID,
        order: SortOrder.Desc,
        skip: 5,
        take: 5,
      });
    });

    it('заметка уволившегося отдаётся без автора', async () => {
      repository.findMany.mockResolvedValue({ rows: [row({ author: null })], total: 1 });

      expect((await service.findAll(STUDENT_ID, query())).items[0]?.author).toBeNull();
    });

    it('404 на неизвестного студента — до запроса ленты', async () => {
      repository.findStudent.mockResolvedValue(null);

      await expect(service.findAll(STUDENT_ID, query())).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findMany).not.toHaveBeenCalled();
    });
  });

  describe('Добавление', () => {
    it('подписывает заметку сотрудником из токена', async () => {
      const result = await service.create(
        STUDENT_ID,
        { text: 'Хорошо работает в команде' },
        ACTOR_ACCOUNT_ID,
      );

      expect(repository.findEmployeeByAccount).toHaveBeenCalledWith(ACTOR_ACCOUNT_ID);
      expect(repository.create).toHaveBeenCalledWith({
        studentId: STUDENT_ID,
        authorId: AUTHOR_ID,
        text: 'Хорошо работает в команде',
      });
      expect(result).toMatchObject({ text: 'Хорошо работает в команде' });
    });

    it('аккаунт без профиля сотрудника оставляет заметку без подписи', async () => {
      repository.findEmployeeByAccount.mockResolvedValue(null);

      await service.create(STUDENT_ID, { text: 'Заметка' }, ACTOR_ACCOUNT_ID);

      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ authorId: null }));
    });

    it('404 на неизвестного студента — до записи', async () => {
      repository.findStudent.mockResolvedValue(null);

      await expect(
        service.create(STUDENT_ID, { text: 'Заметка' }, ACTOR_ACCOUNT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('Удаление', () => {
    it('удаляет и называет начало заметки', async () => {
      expect(await service.remove(STUDENT_ID, FEEDBACK_ID)).toEqual({
        id: FEEDBACK_ID,
        text: 'Пропустил две недели по болезни, догнал программу самостоятельно.',
      });
      expect(repository.delete).toHaveBeenCalledWith(FEEDBACK_ID);
    });

    it('длинная заметка в ответе обрезается', async () => {
      repository.findOne.mockResolvedValue(row({ text: 'а'.repeat(200) }));

      const result = await service.remove(STUDENT_ID, FEEDBACK_ID);

      expect(result.text).toHaveLength(81);
      expect(result.text.endsWith('…')).toBe(true);
    });

    it('404 на заметку о другом студенте', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.remove(STUDENT_ID, FEEDBACK_ID)).rejects.toThrow(/Заметка/);
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('сообщения про студента и про заметку различимы', async () => {
      repository.findStudent.mockResolvedValue(null);

      await expect(service.remove(STUDENT_ID, FEEDBACK_ID)).rejects.toThrow(/Студент/);
      expect(repository.findOne).not.toHaveBeenCalled();
    });
  });
});
