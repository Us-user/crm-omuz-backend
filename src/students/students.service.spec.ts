import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Gender, ParentRelation, StudentStatus } from '@prisma/client';

import { BusinessRuleException, SortOrder } from '../common';
import type { AppConfigService } from '../config';
import { PhoneService } from '../phone/phone.service';
import { StudentQueryDto, StudentSortField } from './dto';
import type { StudentDeletionCheck, StudentRow, StudentsRepository } from './students.repository';
import { StudentsService } from './students.service';

const STUDENT_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_STUDENT_ID = '22222222-2222-2222-2222-222222222222';
const BRANCH_ID = '33333333-3333-3333-3333-333333333333';
const GROUP_ID = '44444444-4444-4444-4444-444444444444';
const COURSE_ID = '55555555-5555-5555-5555-555555555555';
const PARENT_ID = '66666666-6666-6666-6666-666666666666';

const row = (overrides: Partial<StudentRow> = {}): StudentRow => ({
  id: STUDENT_ID,
  firstName: 'Нигина',
  lastName: 'Каримова',
  phone: '+992901234567',
  birthDate: new Date('2004-05-17T00:00:00.000Z'),
  gender: Gender.FEMALE,
  address: 'ул. Рудаки, 105',
  email: 'nigina@mail.tj',
  parents: [
    {
      relation: ParentRelation.MOTHER,
      parent: {
        id: PARENT_ID,
        firstName: 'Гулнора',
        lastName: 'Каримова',
        phone: '+992907654321',
      },
    },
  ],
  extraPhones: ['+992921112233'],
  telegram: '@nigina',
  photoUrl: null,
  notes: null,
  status: StudentStatus.ACTIVE,
  createdAt: new Date('2026-07-27T10:15:00.000Z'),
  branch: { id: BRANCH_ID, name: 'Sadbarg' },
  account: null,
  groups: [
    {
      group: {
        id: GROUP_ID,
        name: 'Frontend-1',
        courseId: COURSE_ID,
        course: { title: 'Frontend Basic' },
      },
    },
  ],
  _count: { groups: 2 },
  ...overrides,
});

const deletable = (overrides: Partial<StudentDeletionCheck> = {}): StudentDeletionCheck => ({
  id: STUDENT_ID,
  firstName: 'Нигина',
  lastName: 'Каримова',
  accountId: null,
  promotedEmployee: null,
  _count: { groups: 0 },
  ...overrides,
});

/** Поля записи без `undefined`: их Prisma пропускает, оставляя колонку прежней. */
const defined = (input: unknown): Partial<StudentRow> =>
  Object.fromEntries(
    Object.entries(input as Record<string, unknown>).filter(([, value]) => value !== undefined),
  );

// Настоящий экземпляр DTO, а не литерал: `skip`/`take` — вычисляемые геттеры,
// и подделанные значения скрыли бы ошибку в переводе страницы в окно выборки.
const query = (overrides: Partial<StudentQueryDto> = {}): StudentQueryDto =>
  Object.assign(new StudentQueryDto(), overrides);

describe('StudentsService', () => {
  let repository: jest.Mocked<
    Pick<
      StudentsRepository,
      | 'findMany'
      | 'findById'
      | 'findByPhone'
      | 'findBranch'
      | 'findForDeletion'
      | 'create'
      | 'update'
      | 'delete'
    >
  >;
  let service: StudentsService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findById: jest.fn().mockResolvedValue(row()),
      findByPhone: jest.fn().mockResolvedValue(null),
      findBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID }),
      findForDeletion: jest.fn().mockResolvedValue(deletable()),
      // Запись отражает то, что делает Prisma: `undefined` означает «колонку
      // не менять», а не «записать пустоту», — иначе тест правки одного поля
      // получал бы карточку, где стёрто всё остальное.
      create: jest
        .fn()
        .mockImplementation((input: unknown) => Promise.resolve(row(defined(input)))),
      update: jest
        .fn()
        .mockImplementation((_: string, input: unknown) => Promise.resolve(row(defined(input)))),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    // Настоящий `PhoneService`: телефоны студентов нормализуются теми же
    // правилами, что и логины (ТЗ 3.1), и заглушка проверяла бы не то
    // поведение, которое увидит оператор.
    const phones = new PhoneService({ defaultPhoneRegion: 'TJ' } as AppConfigService);

    service = new StudentsService(repository as unknown as StudentsRepository, phones);
  });

  describe('Список', () => {
    it('отдаёт карточку с филиалом, действующими группами и историей', async () => {
      const result = await service.findAll(query());

      expect(result.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(result.items[0]).toMatchObject({
        id: STUDENT_ID,
        lastName: 'Каримова',
        branch: { id: BRANCH_ID, name: 'Sadbarg' },
        activeGroups: [{ id: GROUP_ID, name: 'Frontend-1', courseTitle: 'Frontend Basic' }],
        groupsCount: 2,
      });
    });

    it('отдаёт родителей контактами — на месте прежней колонки parentPhone', async () => {
      const result = await service.findAll(query());

      expect(result.items[0]?.parents).toEqual([
        {
          id: PARENT_ID,
          firstName: 'Гулнора',
          lastName: 'Каримова',
          phone: '+992907654321',
          relation: ParentRelation.MOTHER,
        },
      ]);
    });

    it('студент без родителей отдаёт пустой список, а не null', async () => {
      repository.findMany.mockResolvedValue({ rows: [row({ parents: [] })], total: 1 });

      expect((await service.findAll(query())).items[0]?.parents).toEqual([]);
    });

    it('дата рождения отдаётся как YYYY-MM-DD, без времени', async () => {
      const result = await service.findAll(query());

      expect(result.items[0]?.birthDate).toBe('2004-05-17');
    });

    it('передаёт окно страницы и все фильтры ТЗ 5.3', async () => {
      await service.findAll(
        query({
          page: 3,
          limit: 10,
          search: 'каримова',
          status: StudentStatus.NO_ACTIVE,
          branchId: BRANCH_ID,
          groupId: GROUP_ID,
          courseId: COURSE_ID,
          hasAccount: false,
          sort: StudentSortField.CreatedAt,
          order: SortOrder.Desc,
        }),
      );

      expect(repository.findMany).toHaveBeenCalledWith({
        search: 'каримова',
        status: StudentStatus.NO_ACTIVE,
        branchId: BRANCH_ID,
        groupId: GROUP_ID,
        courseId: COURSE_ID,
        hasAccount: false,
        sort: StudentSortField.CreatedAt,
        order: SortOrder.Desc,
        skip: 20,
        take: 10,
      });
    });

    it('по умолчанию сортирует по имени по возрастанию', async () => {
      await service.findAll(query());

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ sort: StudentSortField.Name, order: SortOrder.Asc }),
      );
    });

    it('незаполненные поля отдаются как null, а не как undefined', async () => {
      repository.findMany.mockResolvedValue({
        rows: [row({ birthDate: null, gender: null, branch: null, telegram: null })],
        total: 1,
      });

      expect(await service.findAll(query())).toMatchObject({
        items: [{ birthDate: null, gender: null, branch: null, telegram: null }],
      });
    });
  });

  describe('Карточка', () => {
    it('отдаёт студента по идентификатору', async () => {
      expect(await service.findOne(STUDENT_ID)).toMatchObject({ id: STUDENT_ID });
    });

    it('аккаунт отдаётся без хеша пароля', async () => {
      repository.findById.mockResolvedValue(
        row({
          account: {
            id: 'aaaa1111-1111-1111-1111-111111111111',
            phone: '+992901234567',
            email: 'nigina@mail.tj',
            status: 'ACTIVE',
          },
        }),
      );

      const student = await service.findOne(STUDENT_ID);

      expect(student.account).toMatchObject({ phone: '+992901234567' });
      expect(JSON.stringify(student)).not.toContain('passwordHash');
    });

    it('404 на неизвестного студента', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findOne(STUDENT_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('Создание', () => {
    it('нормализует телефон и доп. телефоны в E.164', async () => {
      await service.create({
        firstName: 'Нигина',
        lastName: 'Каримова',
        phone: '901234567',
        extraPhones: ['92 111 22 33'],
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          phone: '+992901234567',
          extraPhones: ['+992921112233'],
        }),
      );
    });

    it('повтор в доп. телефонах отбрасывается, даже записанный иначе', async () => {
      await service.create({
        firstName: 'Нигина',
        lastName: 'Каримова',
        phone: '901234567',
        extraPhones: ['921112233', '+992 92 111-22-33'],
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ extraPhones: ['+992921112233'] }),
      );
    });

    it('заводит профиль без аккаунта (ТЗ 5.3: Invite отдельно)', async () => {
      repository.create.mockResolvedValue(row({ account: null }));

      expect(
        (await service.create({ firstName: 'Нигина', lastName: 'Каримова', phone: '901234567' }))
          .account,
      ).toBeNull();
    });

    it('незаполненные поля формы пишутся как null, а не как undefined', async () => {
      await service.create({ firstName: 'Нигина', lastName: 'Каримова', phone: '901234567' });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          birthDate: null,
          gender: null,
          address: null,
          email: null,
          extraPhones: [],
          telegram: null,
          photoUrl: null,
          notes: null,
          branchId: null,
        }),
      );
    });

    it('409 на занятый телефон — с именем того, за кем он записан', async () => {
      repository.findByPhone.mockResolvedValue({
        id: OTHER_STUDENT_ID,
        firstName: 'Заррина',
        lastName: 'Сафарова',
      });

      await expect(
        service.create({ firstName: 'Нигина', lastName: 'Каримова', phone: '901234567' }),
      ).rejects.toThrow(/Сафарова Заррина/);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('занятость проверяется по нормализованному номеру', async () => {
      await service.create({ firstName: 'Нигина', lastName: 'Каримова', phone: '901234567' });

      expect(repository.findByPhone).toHaveBeenCalledWith('+992901234567');
    });

    it('422 на несуществующий филиал — профиль не создаётся', async () => {
      repository.findBranch.mockResolvedValue(null);

      await expect(
        service.create({
          firstName: 'Нигина',
          lastName: 'Каримова',
          phone: '901234567',
          branchId: BRANCH_ID,
        }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('без филиала лишнего запроса в справочник не делает', async () => {
      await service.create({ firstName: 'Нигина', lastName: 'Каримова', phone: '901234567' });

      expect(repository.findBranch).not.toHaveBeenCalled();
    });

    it('400 на несуществующую дату рождения (30 февраля)', async () => {
      await expect(
        service.create({
          firstName: 'Нигина',
          lastName: 'Каримова',
          phone: '901234567',
          birthDate: '2004-02-30',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400 на неразбираемый телефон', async () => {
      await expect(
        service.create({ firstName: 'Нигина', lastName: 'Каримова', phone: 'не телефон' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('Правка', () => {
    it('не переданные поля до БД не доходят', async () => {
      await service.update(STUDENT_ID, { notes: 'Перевелась с вечернего потока' });

      expect(repository.update).toHaveBeenCalledWith(STUDENT_ID, {
        firstName: undefined,
        lastName: undefined,
        phone: undefined,
        birthDate: undefined,
        gender: undefined,
        address: undefined,
        email: undefined,
        parentPhone: undefined,
        extraPhones: undefined,
        telegram: undefined,
        photoUrl: undefined,
        notes: 'Перевелась с вечернего потока',
        branchId: undefined,
        status: undefined,
      });
    });

    it('пустая строка очищает необязательное поле', async () => {
      await service.update(STUDENT_ID, { telegram: '', notes: '', address: '' });

      expect(repository.update).toHaveBeenCalledWith(
        STUDENT_ID,
        expect.objectContaining({ telegram: null, notes: null, address: null }),
      );
    });

    it('пустая строка снимает привязку к филиалу и дату рождения', async () => {
      await service.update(STUDENT_ID, { branchId: '', birthDate: '' });

      expect(repository.update).toHaveBeenCalledWith(
        STUDENT_ID,
        expect.objectContaining({ branchId: null, birthDate: null }),
      );
      expect(repository.findBranch).not.toHaveBeenCalled();
    });

    it('пустой массив очищает доп. телефоны', async () => {
      await service.update(STUDENT_ID, { extraPhones: [] });

      expect(repository.update).toHaveBeenCalledWith(
        STUDENT_ID,
        expect.objectContaining({ extraPhones: [] }),
      );
    });

    it('400 на пустой телефон: он обязателен и очистке не подлежит', async () => {
      await expect(service.update(STUDENT_ID, { phone: '' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('свой же телефон конфликтом не считается', async () => {
      repository.findByPhone.mockResolvedValue({
        id: STUDENT_ID,
        firstName: 'Нигина',
        lastName: 'Каримова',
      });

      await expect(service.update(STUDENT_ID, { phone: '901234567' })).resolves.toBeDefined();
    });

    it('409 на телефон другого студента', async () => {
      repository.findByPhone.mockResolvedValue({
        id: OTHER_STUDENT_ID,
        firstName: 'Заррина',
        lastName: 'Сафарова',
      });

      await expect(service.update(STUDENT_ID, { phone: '901234567' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('422 на перенос в несуществующий филиал', async () => {
      repository.findBranch.mockResolvedValue(null);

      await expect(service.update(STUDENT_ID, { branchId: BRANCH_ID })).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('статус можно поставить руками (ТЗ 5.3)', async () => {
      await service.update(STUDENT_ID, { status: StudentStatus.FINISHED });

      expect(repository.update).toHaveBeenCalledWith(
        STUDENT_ID,
        expect.objectContaining({ status: StudentStatus.FINISHED }),
      );
    });

    it('422 на «Block» через правку: вход остался бы открытым', async () => {
      await expect(
        service.update(STUDENT_ID, { status: StudentStatus.BLOCK }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('422 на снятие «Block» правкой: вход остался бы закрытым', async () => {
      repository.findById.mockResolvedValue({ ...row(), status: StudentStatus.BLOCK });

      await expect(
        service.update(STUDENT_ID, { status: StudentStatus.ACTIVE }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('заблокированному можно править остальные поля', async () => {
      repository.findById.mockResolvedValue({ ...row(), status: StudentStatus.BLOCK });

      await service.update(STUDENT_ID, { status: StudentStatus.BLOCK, notes: 'Ждёт разбора' });

      expect(repository.update).toHaveBeenCalledWith(
        STUDENT_ID,
        expect.objectContaining({ notes: 'Ждёт разбора' }),
      );
    });

    it('404 на неизвестного студента — до всех проверок', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.update(STUDENT_ID, { phone: '901234567' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.findByPhone).not.toHaveBeenCalled();
    });
  });

  describe('Удаление', () => {
    it('удаляет «чистый» профиль и называет удалённого', async () => {
      expect(await service.remove(STUDENT_ID)).toEqual({
        id: STUDENT_ID,
        fullName: 'Каримова Нигина',
        accountDeleted: false,
      });
      expect(repository.delete).toHaveBeenCalledWith(STUDENT_ID, null);
    });

    it('аккаунт удаляется вместе с профилем (ТЗ 3.1: логина без профиля нет)', async () => {
      const accountId = 'aaaa1111-1111-1111-1111-111111111111';
      repository.findForDeletion.mockResolvedValue(deletable({ accountId }));

      expect(await service.remove(STUDENT_ID)).toMatchObject({ accountDeleted: true });
      expect(repository.delete).toHaveBeenCalledWith(STUDENT_ID, accountId);
    });

    it('409 на студента с учебной историей — с числом членств', async () => {
      repository.findForDeletion.mockResolvedValue(deletable({ _count: { groups: 3 } }));

      await expect(service.remove(STUDENT_ID)).rejects.toThrow(/членства в группах \(3\)/);
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('закрытые членства держат профиль так же, как действующие', async () => {
      // `_count.groups` считает все строки: группу, из которой студент ушёл,
      // забывать нельзя — на ней держится отчёт по оттоку (ТЗ 5.12).
      repository.findForDeletion.mockResolvedValue(deletable({ _count: { groups: 1 } }));

      await expect(service.remove(STUDENT_ID)).rejects.toBeInstanceOf(ConflictException);
    });

    it('409 на переведённого в сотрудники', async () => {
      repository.findForDeletion.mockResolvedValue(
        deletable({ promotedEmployee: { id: 'eeee1111-1111-1111-1111-111111111111' } }),
      );

      await expect(service.remove(STUDENT_ID)).rejects.toThrow(/переведён в сотрудники/);
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('404 на неизвестного студента', async () => {
      repository.findForDeletion.mockResolvedValue(null);

      await expect(service.remove(STUDENT_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
