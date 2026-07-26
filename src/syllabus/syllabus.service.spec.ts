import { NotFoundException } from '@nestjs/common';
import { DirectoryStatus, LessonType, ResourceFileType, ResourceKind } from '@prisma/client';

import { BusinessRuleException, SortOrder } from '../common';
import { LessonQueryDto, LessonSortField, ResourceFileQueryDto } from './dto';
import type { LessonRow, ResourceFileRow, SyllabusRepository } from './syllabus.repository';
import { SyllabusService } from './syllabus.service';

const COURSE_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_COURSE_ID = '22222222-2222-2222-2222-222222222222';
const LESSON_ID = '33333333-3333-3333-3333-333333333333';
const GROUP_ID = '44444444-4444-4444-4444-444444444444';
const OTHER_GROUP_ID = '55555555-5555-5555-5555-555555555555';
const FILE_ID = '66666666-6666-6666-6666-666666666666';

const lessonRow = (overrides: Partial<LessonRow> = {}): LessonRow => ({
  id: LESSON_ID,
  courseId: COURSE_ID,
  dayNumber: 1,
  title: 'Вёрстка: блочная модель',
  description: null,
  type: LessonType.LECTURE,
  status: DirectoryStatus.ACTIVE,
  visibleToGroups: [],
  _count: { files: 0 },
  createdAt: new Date('2026-07-27T10:00:00.000Z'),
  ...overrides,
});

const fileRow = (overrides: Partial<ResourceFileRow> = {}): ResourceFileRow => ({
  id: FILE_ID,
  lessonId: LESSON_ID,
  title: 'Лекция 1. Блочная модель',
  kind: ResourceKind.LECTURE,
  fileType: ResourceFileType.PDF,
  url: 'https://cdn.omuz.tj/courses/frontend/day-1.pdf',
  description: null,
  createdAt: new Date('2026-07-27T11:00:00.000Z'),
  ...overrides,
});

// Настоящие экземпляры DTO, а не литералы: `skip`/`take` — вычисляемые геттеры,
// и подделанные значения скрыли бы ошибку в переводе страницы в окно выборки.
const lessonQuery = (overrides: Partial<LessonQueryDto> = {}): LessonQueryDto =>
  Object.assign(new LessonQueryDto(), overrides);

const fileQuery = (overrides: Partial<ResourceFileQueryDto> = {}): ResourceFileQueryDto =>
  Object.assign(new ResourceFileQueryDto(), overrides);

describe('SyllabusService', () => {
  let repository: jest.Mocked<
    Pick<
      SyllabusRepository,
      | 'findLessons'
      | 'findLesson'
      | 'findCourse'
      | 'findCourseGroups'
      | 'createLesson'
      | 'updateLesson'
      | 'deleteLesson'
      | 'findFiles'
      | 'findFile'
      | 'createFile'
      | 'deleteFile'
    >
  >;
  let service: SyllabusService;

  beforeEach(() => {
    repository = {
      findLessons: jest.fn().mockResolvedValue({ rows: [lessonRow()], total: 1 }),
      findLesson: jest.fn().mockResolvedValue(lessonRow()),
      findCourse: jest.fn().mockResolvedValue({ id: COURSE_ID, title: 'Frontend Basic' }),
      findCourseGroups: jest.fn().mockResolvedValue([{ id: GROUP_ID, name: 'Frontend-1' }]),
      createLesson: jest.fn().mockImplementation(() => Promise.resolve(lessonRow())),
      updateLesson: jest.fn().mockImplementation(() => Promise.resolve(lessonRow())),
      deleteLesson: jest.fn().mockResolvedValue(undefined),
      findFiles: jest.fn().mockResolvedValue({ rows: [fileRow()], total: 1 }),
      findFile: jest.fn().mockResolvedValue(fileRow()),
      createFile: jest.fn().mockImplementation(() => Promise.resolve(fileRow())),
      deleteFile: jest.fn().mockResolvedValue(undefined),
    };

    service = new SyllabusService(repository as unknown as SyllabusRepository);
  });

  describe('findAllLessons', () => {
    it('отдаёт уроки курса со счётчиком материалов и мультивыбором групп', async () => {
      repository.findLessons.mockResolvedValue({
        rows: [
          lessonRow({
            visibleToGroups: [{ group: { id: GROUP_ID, name: 'Frontend-1' } }],
            _count: { files: 3 },
          }),
        ],
        total: 1,
      });

      const result = await service.findAllLessons(COURSE_ID, lessonQuery());

      expect(result.items[0]).toMatchObject({
        courseId: COURSE_ID,
        dayNumber: 1,
        filesCount: 3,
        visibleToGroups: [{ id: GROUP_ID, name: 'Frontend-1' }],
      });
    });

    it('передаёт окно страницы, фильтры и порядок дней по умолчанию', async () => {
      await service.findAllLessons(
        COURSE_ID,
        lessonQuery({
          page: 3,
          limit: 5,
          type: LessonType.EXAM,
          status: DirectoryStatus.INACTIVE,
          groupId: GROUP_ID,
          search: 'вёрстка',
        }),
      );

      expect(repository.findLessons).toHaveBeenCalledWith({
        courseId: COURSE_ID,
        search: 'вёрстка',
        type: LessonType.EXAM,
        status: DirectoryStatus.INACTIVE,
        groupId: GROUP_ID,
        sort: LessonSortField.DayNumber,
        order: SortOrder.Asc,
        skip: 10,
        take: 5,
      });
    });

    it('неизвестный курс — 404, программа не запрашивается', async () => {
      repository.findCourse.mockResolvedValue(null);

      await expect(service.findAllLessons(COURSE_ID, lessonQuery())).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.findLessons).not.toHaveBeenCalled();
    });
  });

  describe('createLesson', () => {
    const body = { dayNumber: 1, title: 'Вёрстка: блочная модель' };

    it('добавляет урок в программу курса из пути', async () => {
      await service.createLesson(COURSE_ID, body);

      expect(repository.createLesson).toHaveBeenCalledWith(
        {
          courseId: COURSE_ID,
          dayNumber: 1,
          title: 'Вёрстка: блочная модель',
          description: null,
          type: undefined,
          status: undefined,
        },
        [],
      );
    });

    it('открывает урок группам курса («Show to group»)', async () => {
      await service.createLesson(COURSE_ID, { ...body, visibleToGroupIds: [GROUP_ID] });

      expect(repository.findCourseGroups).toHaveBeenCalledWith(COURSE_ID, [GROUP_ID]);
      expect(repository.createLesson).toHaveBeenCalledWith(expect.anything(), [GROUP_ID]);
    });

    it('группа другого курса — 422 с перечислением недостающих, урок не создаётся', async () => {
      repository.findCourseGroups.mockResolvedValue([{ id: GROUP_ID, name: 'Frontend-1' }]);

      const failure = service.createLesson(COURSE_ID, {
        ...body,
        visibleToGroupIds: [GROUP_ID, OTHER_GROUP_ID],
      });

      await expect(failure).rejects.toThrow(BusinessRuleException);
      await expect(failure).rejects.toMatchObject({
        response: { details: { visibleToGroupIds: [OTHER_GROUP_ID] } },
      });
      expect(repository.createLesson).not.toHaveBeenCalled();
    });

    it('пустой мультивыбор не идёт в БД лишним запросом', async () => {
      await service.createLesson(COURSE_ID, { ...body, visibleToGroupIds: [] });

      expect(repository.findCourseGroups).not.toHaveBeenCalled();
      expect(repository.createLesson).toHaveBeenCalledWith(expect.anything(), []);
    });

    it('тип и статус передаются как есть', async () => {
      await service.createLesson(COURSE_ID, {
        ...body,
        type: LessonType.EXAM,
        status: DirectoryStatus.INACTIVE,
      });

      expect(repository.createLesson).toHaveBeenCalledWith(
        expect.objectContaining({ type: LessonType.EXAM, status: DirectoryStatus.INACTIVE }),
        [],
      );
    });

    it('пустое описание записывается как null, а не как пустая строка', async () => {
      await service.createLesson(COURSE_ID, { ...body, description: '' });

      expect(repository.createLesson).toHaveBeenCalledWith(
        expect.objectContaining({ description: null }),
        [],
      );
    });

    it('неизвестный курс — 404', async () => {
      repository.findCourse.mockResolvedValue(null);

      await expect(service.createLesson(COURSE_ID, body)).rejects.toThrow(NotFoundException);
      expect(repository.createLesson).not.toHaveBeenCalled();
    });

    it('второй урок с тем же номером дня допустим (в день бывают лекция и практика)', async () => {
      await service.createLesson(COURSE_ID, { dayNumber: 1, title: 'Практика по вёрстке' });

      expect(repository.createLesson).toHaveBeenCalledWith(
        expect.objectContaining({ dayNumber: 1 }),
        [],
      );
    });
  });

  describe('findOneLesson', () => {
    it('ищет урок вместе с курсом из пути', async () => {
      await service.findOneLesson(COURSE_ID, LESSON_ID);

      expect(repository.findLesson).toHaveBeenCalledWith(COURSE_ID, LESSON_ID);
    });

    it('урок чужого курса не находится — 404', async () => {
      repository.findLesson.mockResolvedValue(null);

      await expect(service.findOneLesson(OTHER_COURSE_ID, LESSON_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('неизвестный курс и пропавший урок различимы по сообщению', async () => {
      repository.findCourse.mockResolvedValue(null);
      await expect(service.findOneLesson(COURSE_ID, LESSON_ID)).rejects.toThrow('Курс не найден');

      repository.findCourse.mockResolvedValue({ id: COURSE_ID, title: 'Frontend Basic' });
      repository.findLesson.mockResolvedValue(null);
      await expect(service.findOneLesson(COURSE_ID, LESSON_ID)).rejects.toThrow(
        'Урок не найден в программе этого курса',
      );
    });
  });

  describe('updateLesson', () => {
    it('не переданный мультивыбор не трогается', async () => {
      await service.updateLesson(COURSE_ID, LESSON_ID, { title: 'Новое название' });

      expect(repository.findCourseGroups).not.toHaveBeenCalled();
      expect(repository.updateLesson).toHaveBeenCalledWith(
        LESSON_ID,
        expect.objectContaining({ title: 'Новое название' }),
        undefined,
      );
    });

    it('пустой массив снимает урок со всех групп', async () => {
      await service.updateLesson(COURSE_ID, LESSON_ID, { visibleToGroupIds: [] });

      expect(repository.updateLesson).toHaveBeenCalledWith(LESSON_ID, expect.anything(), []);
    });

    it('переданный список заменяет мультивыбор целиком', async () => {
      repository.findCourseGroups.mockResolvedValue([
        { id: GROUP_ID, name: 'Frontend-1' },
        { id: OTHER_GROUP_ID, name: 'Frontend-2' },
      ]);

      await service.updateLesson(COURSE_ID, LESSON_ID, {
        visibleToGroupIds: [GROUP_ID, OTHER_GROUP_ID],
      });

      expect(repository.updateLesson).toHaveBeenCalledWith(LESSON_ID, expect.anything(), [
        GROUP_ID,
        OTHER_GROUP_ID,
      ]);
    });

    it('группа другого курса — 422, урок не меняется', async () => {
      repository.findCourseGroups.mockResolvedValue([]);

      await expect(
        service.updateLesson(COURSE_ID, LESSON_ID, { visibleToGroupIds: [OTHER_GROUP_ID] }),
      ).rejects.toThrow(BusinessRuleException);
      expect(repository.updateLesson).not.toHaveBeenCalled();
    });

    it('пустая строка очищает описание, не переданное поле остаётся undefined', async () => {
      await service.updateLesson(COURSE_ID, LESSON_ID, { description: '' });
      expect(repository.updateLesson).toHaveBeenCalledWith(
        LESSON_ID,
        expect.objectContaining({ description: null }),
        undefined,
      );

      repository.updateLesson.mockClear();
      await service.updateLesson(COURSE_ID, LESSON_ID, { dayNumber: 2 });
      expect(repository.updateLesson).toHaveBeenCalledWith(
        LESSON_ID,
        expect.objectContaining({ dayNumber: 2, description: undefined }),
        undefined,
      );
    });

    it('урок чужого курса не правится — 404', async () => {
      repository.findLesson.mockResolvedValue(null);

      await expect(
        service.updateLesson(OTHER_COURSE_ID, LESSON_ID, { title: 'Взлом' }),
      ).rejects.toThrow(NotFoundException);
      expect(repository.updateLesson).not.toHaveBeenCalled();
    });
  });

  describe('removeLesson', () => {
    it('удаляет урок и называет удалённое', async () => {
      const result = await service.removeLesson(COURSE_ID, LESSON_ID);

      expect(repository.deleteLesson).toHaveBeenCalledWith(LESSON_ID);
      expect(result).toEqual({
        id: LESSON_ID,
        dayNumber: 1,
        title: 'Вёрстка: блочная модель',
      });
    });

    it('урок с материалами удаляется без отказа — файлы уносит каскад', async () => {
      repository.findLesson.mockResolvedValue(lessonRow({ _count: { files: 4 } }));

      await expect(service.removeLesson(COURSE_ID, LESSON_ID)).resolves.toMatchObject({
        id: LESSON_ID,
      });
      expect(repository.deleteLesson).toHaveBeenCalledWith(LESSON_ID);
    });

    it('урок чужого курса не удаляется — 404', async () => {
      repository.findLesson.mockResolvedValue(null);

      await expect(service.removeLesson(OTHER_COURSE_ID, LESSON_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.deleteLesson).not.toHaveBeenCalled();
    });
  });

  describe('материалы урока', () => {
    it('отдаёт материалы с обоими типами из ТЗ 5.6', async () => {
      const result = await service.findAllFiles(COURSE_ID, LESSON_ID, fileQuery());

      expect(result.items[0]).toMatchObject({
        lessonId: LESSON_ID,
        kind: ResourceKind.LECTURE,
        fileType: ResourceFileType.PDF,
        url: 'https://cdn.omuz.tj/courses/frontend/day-1.pdf',
      });
    });

    it('передаёт окно страницы и оба фильтра', async () => {
      await service.findAllFiles(
        COURSE_ID,
        LESSON_ID,
        fileQuery({
          page: 2,
          limit: 10,
          kind: ResourceKind.HOMEWORK,
          fileType: ResourceFileType.LINK,
        }),
      );

      expect(repository.findFiles).toHaveBeenCalledWith(
        expect.objectContaining({
          lessonId: LESSON_ID,
          kind: ResourceKind.HOMEWORK,
          fileType: ResourceFileType.LINK,
          skip: 10,
          take: 10,
        }),
      );
    });

    it('материалы урока чужого курса не читаются — 404', async () => {
      repository.findLesson.mockResolvedValue(null);

      await expect(service.findAllFiles(OTHER_COURSE_ID, LESSON_ID, fileQuery())).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.findFiles).not.toHaveBeenCalled();
    });

    it('добавляет материал к уроку', async () => {
      await service.createFile(COURSE_ID, LESSON_ID, {
        title: 'Домашка 1',
        kind: ResourceKind.HOMEWORK,
        fileType: ResourceFileType.DOC,
        url: 'https://cdn.omuz.tj/hw-1.docx',
        description: '',
      });

      expect(repository.createFile).toHaveBeenCalledWith({
        lessonId: LESSON_ID,
        title: 'Домашка 1',
        kind: ResourceKind.HOMEWORK,
        fileType: ResourceFileType.DOC,
        url: 'https://cdn.omuz.tj/hw-1.docx',
        description: null,
      });
    });

    it('материал нельзя добавить в урок чужого курса — 404', async () => {
      repository.findLesson.mockResolvedValue(null);

      await expect(
        service.createFile(OTHER_COURSE_ID, LESSON_ID, {
          title: 'Домашка 1',
          url: 'https://cdn.omuz.tj/hw-1.docx',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(repository.createFile).not.toHaveBeenCalled();
    });

    it('удаляет материал и называет удалённое', async () => {
      const result = await service.removeFile(COURSE_ID, LESSON_ID, FILE_ID);

      expect(repository.findFile).toHaveBeenCalledWith(LESSON_ID, FILE_ID);
      expect(repository.deleteFile).toHaveBeenCalledWith(FILE_ID);
      expect(result).toEqual({ id: FILE_ID, title: 'Лекция 1. Блочная модель' });
    });

    it('материал чужого урока не удаляется — 404', async () => {
      repository.findFile.mockResolvedValue(null);

      await expect(service.removeFile(COURSE_ID, LESSON_ID, FILE_ID)).rejects.toThrow(
        'Материал не найден',
      );
      expect(repository.deleteFile).not.toHaveBeenCalled();
    });
  });
});
