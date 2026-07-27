import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ParentRelation } from '@prisma/client';

import { SortOrder } from '../common';
import type { AppConfigService } from '../config';
import { PhoneService } from '../phone/phone.service';
import { StudentParentQueryDto, StudentParentSortField } from './dto';
import type {
  ParentLinkRow,
  ParentRow,
  StudentParentsRepository,
} from './student-parents.repository';
import { StudentParentsService } from './student-parents.service';

const STUDENT_ID = '11111111-1111-1111-1111-111111111111';
const PARENT_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_PARENT_ID = '33333333-3333-3333-3333-333333333333';

const PHONE = '+992907654321';

const parent = (overrides: Partial<ParentRow> = {}): ParentRow => ({
  id: PARENT_ID,
  firstName: 'Гулнора',
  lastName: 'Каримова',
  phone: PHONE,
  email: null,
  telegram: null,
  notes: null,
  ...overrides,
});

const link = (overrides: Partial<ParentLinkRow> = {}): ParentLinkRow => ({
  relation: ParentRelation.MOTHER,
  createdAt: new Date('2026-07-29T09:30:00.000Z'),
  parent: { ...parent(), _count: { students: 1 } },
  ...overrides,
});

// Настоящий экземпляр DTO, а не литерал: `skip`/`take` — вычисляемые геттеры.
const query = (overrides: Partial<StudentParentQueryDto> = {}): StudentParentQueryDto =>
  Object.assign(new StudentParentQueryDto(), overrides);

describe('StudentParentsService', () => {
  let repository: jest.Mocked<
    Pick<
      StudentParentsRepository,
      | 'findMany'
      | 'findStudent'
      | 'findParentByPhone'
      | 'findLink'
      | 'create'
      | 'link'
      | 'update'
      | 'unlink'
    >
  >;
  let service: StudentParentsService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [link()], total: 1 }),
      findStudent: jest.fn().mockResolvedValue({ id: STUDENT_ID }),
      findParentByPhone: jest.fn().mockResolvedValue(null),
      findLink: jest.fn().mockResolvedValue(link()),
      create: jest.fn().mockResolvedValue(link()),
      link: jest.fn().mockResolvedValue(link()),
      update: jest.fn().mockResolvedValue(link()),
      unlink: jest.fn().mockResolvedValue({ parentDeleted: true }),
    };

    // Настоящий `PhoneService`: телефоны родителей нормализуются теми же
    // правилами, что телефоны студентов, — подмена проверяла бы не то.
    const phones = new PhoneService({ defaultPhoneRegion: 'TJ' } as AppConfigService);

    service = new StudentParentsService(repository as unknown as StudentParentsRepository, phones);
  });

  describe('Список', () => {
    it('отдаёт контакт, родство и число детей в центре', async () => {
      const result = await service.findAll(STUDENT_ID, query());

      expect(result.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(result.items[0]).toMatchObject({
        id: PARENT_ID,
        lastName: 'Каримова',
        phone: PHONE,
        relation: ParentRelation.MOTHER,
        childrenCount: 1,
        linkedAt: '2026-07-29T09:30:00.000Z',
      });
    });

    it('по умолчанию идёт в порядке добавления', async () => {
      await service.findAll(STUDENT_ID, query());

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          sort: StudentParentSortField.CreatedAt,
          order: SortOrder.Asc,
        }),
      );
    });

    it('передаёт окно страницы, поиск и фильтр родства', async () => {
      await service.findAll(
        STUDENT_ID,
        query({ page: 2, limit: 5, search: 'Карим', relation: ParentRelation.FATHER }),
      );

      expect(repository.findMany).toHaveBeenCalledWith({
        studentId: STUDENT_ID,
        search: 'Карим',
        relation: ParentRelation.FATHER,
        sort: StudentParentSortField.CreatedAt,
        order: SortOrder.Asc,
        skip: 5,
        take: 5,
      });
    });

    it('родитель из регистрации отдаётся без имени и родства', async () => {
      repository.findMany.mockResolvedValue({
        rows: [
          link({
            relation: null,
            parent: {
              ...parent({ firstName: null, lastName: null }),
              _count: { students: 1 },
            },
          }),
        ],
        total: 1,
      });

      expect(await service.findAll(STUDENT_ID, query())).toMatchObject({
        items: [{ firstName: null, lastName: null, relation: null }],
      });
    });

    it('404 на неизвестного студента — до запроса списка', async () => {
      repository.findStudent.mockResolvedValue(null);

      await expect(service.findAll(STUDENT_ID, query())).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findMany).not.toHaveBeenCalled();
    });
  });

  describe('Добавление', () => {
    it('заводит нового родителя с нормализованным телефоном', async () => {
      const result = await service.create(STUDENT_ID, {
        phone: '90 765-43-21',
        firstName: 'Гулнора',
        lastName: 'Каримова',
        relation: ParentRelation.MOTHER,
      });

      expect(repository.create).toHaveBeenCalledWith({
        studentId: STUDENT_ID,
        parent: expect.objectContaining({ phone: PHONE, firstName: 'Гулнора' }),
        relation: ParentRelation.MOTHER,
      });
      expect(result).toMatchObject({ id: PARENT_ID, created: true });
      expect(repository.link).not.toHaveBeenCalled();
    });

    it('незаполненные поля уходят в БД как null, а не undefined', async () => {
      await service.create(STUDENT_ID, { phone: PHONE });

      expect(repository.create).toHaveBeenCalledWith({
        studentId: STUDENT_ID,
        parent: {
          phone: PHONE,
          firstName: null,
          lastName: null,
          email: null,
          telegram: null,
          notes: null,
        },
        relation: null,
      });
    });

    it('привязывает существующего родителя вместо второй записи', async () => {
      repository.findParentByPhone.mockResolvedValue(parent());
      repository.findLink.mockResolvedValue(null);
      repository.link.mockResolvedValue(link({ parent: { ...parent(), _count: { students: 2 } } }));

      const result = await service.create(STUDENT_ID, { phone: PHONE });

      expect(repository.create).not.toHaveBeenCalled();
      expect(repository.link).toHaveBeenCalledWith(
        expect.objectContaining({ studentId: STUDENT_ID, parentId: PARENT_ID }),
      );
      expect(result).toMatchObject({ created: false, childrenCount: 2 });
    });

    it('дозаполняет пустые поля существующей записи', async () => {
      repository.findParentByPhone.mockResolvedValue(parent({ firstName: null, lastName: null }));
      repository.findLink.mockResolvedValue(null);

      await service.create(STUDENT_ID, {
        phone: PHONE,
        firstName: 'Гулнора',
        lastName: 'Каримова',
      });

      expect(repository.link).toHaveBeenCalledWith(
        expect.objectContaining({ fill: { firstName: 'Гулнора', lastName: 'Каримова' } }),
      );
    });

    it('заполненные поля существующей записи не перезаписывает', async () => {
      repository.findParentByPhone.mockResolvedValue(parent({ firstName: 'Гулнора' }));
      repository.findLink.mockResolvedValue(null);

      await service.create(STUDENT_ID, {
        phone: PHONE,
        firstName: 'Гулноро',
        notes: 'звонить после 18',
      });

      expect(repository.link).toHaveBeenCalledWith(
        expect.objectContaining({ fill: { notes: 'звонить после 18' } }),
      );
    });

    it('родство берётся из запроса и не трогает чужие связки', async () => {
      repository.findParentByPhone.mockResolvedValue(parent());
      repository.findLink.mockResolvedValue(null);

      await service.create(STUDENT_ID, { phone: PHONE, relation: ParentRelation.GUARDIAN });

      expect(repository.link).toHaveBeenCalledWith(
        expect.objectContaining({ relation: ParentRelation.GUARDIAN }),
      );
    });

    it('409, если родитель уже записан у этого студента', async () => {
      repository.findParentByPhone.mockResolvedValue(parent());
      repository.findLink.mockResolvedValue(link());

      await expect(service.create(STUDENT_ID, { phone: PHONE })).rejects.toThrow(
        /Каримова Гулнора/,
      );
      expect(repository.link).not.toHaveBeenCalled();
    });

    it('400 на неразобранный номер', async () => {
      await expect(service.create(STUDENT_ID, { phone: 'не телефон' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('404 на неизвестного студента — до поиска родителя', async () => {
      repository.findStudent.mockResolvedValue(null);

      await expect(service.create(STUDENT_ID, { phone: PHONE })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.findParentByPhone).not.toHaveBeenCalled();
    });
  });

  describe('Правка', () => {
    it('пишет только переданные поля', async () => {
      await service.update(STUDENT_ID, PARENT_ID, { firstName: 'Гулноро' });

      expect(repository.update).toHaveBeenCalledWith({
        studentId: STUDENT_ID,
        parentId: PARENT_ID,
        parent: { firstName: 'Гулноро' },
        relation: undefined,
      });
    });

    it('пустая строка очищает поле, а пустое родство — снимает', async () => {
      await service.update(STUDENT_ID, PARENT_ID, {
        notes: '',
        relation: '' as unknown as ParentRelation,
      });

      expect(repository.update).toHaveBeenCalledWith(
        expect.objectContaining({ parent: { notes: null }, relation: null }),
      );
    });

    it('нормализует новый телефон и проверяет, что он свободен', async () => {
      await service.update(STUDENT_ID, PARENT_ID, { phone: '90 765-43-21' });

      expect(repository.findParentByPhone).toHaveBeenCalledWith(PHONE);
      expect(repository.update).toHaveBeenCalledWith(
        expect.objectContaining({ parent: { phone: PHONE } }),
      );
    });

    it('свой же телефон конфликтом не считается', async () => {
      repository.findParentByPhone.mockResolvedValue(parent());

      await expect(service.update(STUDENT_ID, PARENT_ID, { phone: PHONE })).resolves.toMatchObject({
        id: PARENT_ID,
      });
    });

    it('409 на телефон другого родителя — слияния записей нет', async () => {
      repository.findParentByPhone.mockResolvedValue(parent({ id: OTHER_PARENT_ID }));

      await expect(service.update(STUDENT_ID, PARENT_ID, { phone: PHONE })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('400 на пустой телефон — ключ записи не очищается', async () => {
      await expect(service.update(STUDENT_ID, PARENT_ID, { phone: '' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('404, если родитель не записан у этого студента', async () => {
      repository.findLink.mockResolvedValue(null);

      await expect(service.update(STUDENT_ID, PARENT_ID, { firstName: 'Гулноро' })).rejects.toThrow(
        /не записан у этого студента/,
      );
    });

    it('сообщения про студента и про родителя различимы', async () => {
      repository.findStudent.mockResolvedValue(null);

      await expect(service.update(STUDENT_ID, PARENT_ID, {})).rejects.toThrow(/Студент не найден/);
    });
  });

  describe('Отвязка', () => {
    it('убирает родителя и называет удалённого', async () => {
      const result = await service.remove(STUDENT_ID, PARENT_ID);

      expect(repository.unlink).toHaveBeenCalledWith(STUDENT_ID, PARENT_ID);
      expect(result).toEqual({
        id: PARENT_ID,
        phone: PHONE,
        fullName: 'Каримова Гулнора',
        parentDeleted: true,
      });
    });

    it('у родителя с другими детьми запись остаётся', async () => {
      repository.unlink.mockResolvedValue({ parentDeleted: false });

      expect(await service.remove(STUDENT_ID, PARENT_ID)).toMatchObject({ parentDeleted: false });
    });

    it('родитель без имени отдаётся с fullName = null', async () => {
      repository.findLink.mockResolvedValue(
        link({
          parent: {
            ...parent({ firstName: null, lastName: null }),
            _count: { students: 1 },
          },
        }),
      );

      expect(await service.remove(STUDENT_ID, PARENT_ID)).toMatchObject({ fullName: null });
    });

    it('404 на родителя другого студента — ничего не удаляем', async () => {
      repository.findLink.mockResolvedValue(null);

      await expect(service.remove(STUDENT_ID, PARENT_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.unlink).not.toHaveBeenCalled();
    });
  });
});
