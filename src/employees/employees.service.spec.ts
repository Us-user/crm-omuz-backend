import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AccountStatus, EmployeeStatus, Gender, GroupMentorRole } from '@prisma/client';

import { BusinessRuleException, SortOrder } from '../common';
import type { AppConfigService } from '../config';
import { PhoneService } from '../phone/phone.service';
import type { PermissionsService } from '../rbac/permissions.service';
import { EmployeeQueryDto, EmployeeSortField } from './dto';
import type {
  EmployeeDeletionCheck,
  EmployeeRow,
  EmployeesRepository,
} from './employees.repository';
import { EmployeesService } from './employees.service';

const EMPLOYEE_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_EMPLOYEE_ID = '22222222-2222-2222-2222-222222222222';
const ACTOR_ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';
const BRANCH_ID = '44444444-4444-4444-4444-444444444444';
const GROUP_ID = '55555555-5555-5555-5555-555555555555';
const COURSE_ID = '66666666-6666-6666-6666-666666666666';
const ACCOUNT_ID = '77777777-7777-7777-7777-777777777777';
const MENTOR_POSITION_ID = '88888888-8888-8888-8888-888888888888';
const DIRECTOR_POSITION_ID = '99999999-9999-9999-9999-999999999999';

const MENTOR_POSITION = { id: MENTOR_POSITION_ID, name: 'Mentor', isSystem: false };
const DIRECTOR_POSITION = { id: DIRECTOR_POSITION_ID, name: 'Director', isSystem: true };

const row = (overrides: Partial<EmployeeRow> = {}): EmployeeRow => ({
  id: EMPLOYEE_ID,
  firstName: 'Фаррух',
  lastName: 'Раҳимов',
  middleName: 'Саидович',
  phone: '+992901234567',
  birthDate: new Date('1994-03-12T00:00:00.000Z'),
  gender: Gender.MALE,
  address: 'ул. Рудаки, 105',
  email: 'farrukh@omuz.tj',
  telegram: '@farrukh',
  photoUrl: null,
  experience: '5 лет разработки',
  description: null,
  status: EmployeeStatus.ACTIVE,
  hiredAt: new Date('2026-01-15T00:00:00.000Z'),
  formerStudentId: null,
  createdAt: new Date('2026-07-27T10:15:00.000Z'),
  branch: { id: BRANCH_ID, name: 'Sadbarg' },
  account: null,
  positions: [{ position: MENTOR_POSITION }],
  mentorGroups: [
    {
      role: GroupMentorRole.TEACHING,
      group: {
        id: GROUP_ID,
        name: 'Frontend-1',
        courseId: COURSE_ID,
        course: { title: 'Frontend Basic' },
      },
    },
  ],
  ...overrides,
});

const deletable = (overrides: Partial<EmployeeDeletionCheck> = {}): EmployeeDeletionCheck => ({
  id: EMPLOYEE_ID,
  firstName: 'Фаррух',
  lastName: 'Раҳимов',
  accountId: null,
  status: EmployeeStatus.ACTIVE,
  positions: [{ position: MENTOR_POSITION }],
  _count: {
    mentorGroups: 0,
    mentorSlots: 0,
    submittedWeeks: 0,
    authoredFeedback: 0,
    awardedCoins: 0,
    taughtDays: 0,
    salaries: 0,
  },
  ...overrides,
});

/** Поля записи без `undefined`: их Prisma пропускает, оставляя колонку прежней. */
const defined = (input: unknown): Partial<EmployeeRow> =>
  Object.fromEntries(
    Object.entries(input as Record<string, unknown>).filter(([, value]) => value !== undefined),
  );

// Настоящий экземпляр DTO, а не литерал: `skip`/`take` — вычисляемые геттеры,
// и подделанные значения скрыли бы ошибку в переводе страницы в окно выборки.
const query = (overrides: Partial<EmployeeQueryDto> = {}): EmployeeQueryDto =>
  Object.assign(new EmployeeQueryDto(), overrides);

describe('EmployeesService', () => {
  let repository: jest.Mocked<
    Pick<
      EmployeesRepository,
      | 'findMany'
      | 'findById'
      | 'findByPhone'
      | 'findBranch'
      | 'findPositionsByIds'
      | 'countPositionHolders'
      | 'findForDeletion'
      | 'create'
      | 'update'
      | 'delete'
    >
  >;
  let permissions: jest.Mocked<Pick<PermissionsService, 'hasPermissions'>>;
  let service: EmployeesService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
      findById: jest.fn().mockResolvedValue(row()),
      findByPhone: jest.fn().mockResolvedValue(null),
      findBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID }),
      findPositionsByIds: jest
        .fn()
        .mockImplementation((ids: readonly string[]) =>
          Promise.resolve(
            [MENTOR_POSITION, DIRECTOR_POSITION].filter((position) => ids.includes(position.id)),
          ),
        ),
      countPositionHolders: jest.fn().mockResolvedValue(0),
      findForDeletion: jest.fn().mockResolvedValue(deletable()),
      // Запись отражает то, что делает Prisma: `undefined` означает «колонку
      // не менять», а не «записать пустоту», — иначе тест правки одного поля
      // получал бы карточку, где стёрто всё остальное.
      create: jest
        .fn()
        .mockImplementation((input: unknown) => Promise.resolve(row(defined(input)))),
      update: jest
        .fn()
        .mockImplementation((_: string, input: unknown) =>
          Promise.resolve({ employee: row(defined(input)), revokedSessions: 0 }),
        ),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    // По умолчанию вызывающий вправе менять роли: иначе каждый случай формы
    // с позициями начинался бы с выдачи права.
    permissions = { hasPermissions: jest.fn().mockResolvedValue(true) };

    // Настоящий `PhoneService`: телефоны сотрудников нормализуются теми же
    // правилами, что и логины (ТЗ 3.1), и заглушка проверяла бы не то
    // поведение, которое увидит оператор.
    const phones = new PhoneService({ defaultPhoneRegion: 'TJ' } as AppConfigService);

    service = new EmployeesService(
      repository as unknown as EmployeesRepository,
      phones,
      permissions as unknown as PermissionsService,
    );
  });

  describe('Список (ТЗ 5.14)', () => {
    it('отдаёт карточку с филиалом, позициями и группами', async () => {
      const result = await service.findAll(query());

      expect(result.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(result.items[0]).toMatchObject({
        id: EMPLOYEE_ID,
        lastName: 'Раҳимов',
        middleName: 'Саидович',
        branch: { id: BRANCH_ID, name: 'Sadbarg' },
        positions: [MENTOR_POSITION],
        groups: [
          {
            id: GROUP_ID,
            name: 'Frontend-1',
            courseTitle: 'Frontend Basic',
            role: GroupMentorRole.TEACHING,
          },
        ],
      });
    });

    it('даты — YYYY-MM-DD, без времени', async () => {
      expect(result0(await service.findAll(query()))).toMatchObject({
        birthDate: '1994-03-12',
        hiredAt: '2026-01-15',
      });
    });

    it('передаёт окно страницы и все фильтры', async () => {
      await service.findAll(
        query({
          page: 3,
          limit: 10,
          search: 'Раҳимов',
          status: EmployeeStatus.INACTIVE,
          branchId: BRANCH_ID,
          positionId: MENTOR_POSITION_ID,
          hasAccount: false,
          sort: EmployeeSortField.HiredAt,
          order: SortOrder.Desc,
        }),
      );

      expect(repository.findMany).toHaveBeenCalledWith({
        search: 'Раҳимов',
        status: EmployeeStatus.INACTIVE,
        branchId: BRANCH_ID,
        positionId: MENTOR_POSITION_ID,
        hasAccount: false,
        sort: EmployeeSortField.HiredAt,
        order: SortOrder.Desc,
        skip: 20,
        take: 10,
      });
    });

    it('незаполненные поля отдаются как null', async () => {
      repository.findMany.mockResolvedValue({
        rows: [
          row({
            middleName: null,
            birthDate: null,
            gender: null,
            address: null,
            email: null,
            branch: null,
            hiredAt: null,
            experience: null,
            positions: [],
            mentorGroups: [],
          }),
        ],
        total: 1,
      });

      expect(result0(await service.findAll(query()))).toMatchObject({
        middleName: null,
        birthDate: null,
        branch: null,
        hiredAt: null,
        experience: null,
        account: null,
        positions: [],
        groups: [],
      });
    });
  });

  describe('Карточка', () => {
    it('отдаёт сотрудника по идентификатору', async () => {
      expect(await service.findOne(EMPLOYEE_ID)).toMatchObject({ id: EMPLOYEE_ID });
      expect(repository.findById).toHaveBeenCalledWith(EMPLOYEE_ID);
    });

    it('404 на неизвестного', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.findOne(EMPLOYEE_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('аккаунт отдаётся без хеша пароля', async () => {
      repository.findById.mockResolvedValue(
        row({
          account: {
            id: ACCOUNT_ID,
            phone: '+992901234567',
            email: 'farrukh@omuz.tj',
            status: AccountStatus.ACTIVE,
          },
        }),
      );

      const result = await service.findOne(EMPLOYEE_ID);

      expect(result.account).toEqual({
        id: ACCOUNT_ID,
        phone: '+992901234567',
        email: 'farrukh@omuz.tj',
        status: AccountStatus.ACTIVE,
      });
      expect(JSON.stringify(result)).not.toContain('passwordHash');
    });
  });

  describe('Создание (ТЗ 5.14)', () => {
    const dto = {
      firstName: 'Фаррух',
      lastName: 'Раҳимов',
      phone: '90 123 45 67',
    };

    it('нормализует телефон в E.164', async () => {
      await service.create(dto, ACTOR_ACCOUNT_ID);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '+992901234567' }),
        undefined,
      );
    });

    it('заводит профиль без аккаунта — логин по ТЗ 5.14 опционален', async () => {
      repository.create.mockResolvedValue(row({ account: null }));

      expect((await service.create(dto, ACTOR_ACCOUNT_ID)).account).toBeNull();
    });

    it('незаполненные поля формы записываются как null, а не undefined', async () => {
      await service.create(dto, ACTOR_ACCOUNT_ID);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          middleName: null,
          address: null,
          email: null,
          telegram: null,
          photoUrl: null,
          experience: null,
          description: null,
          branchId: null,
          birthDate: null,
          hiredAt: null,
        }),
        undefined,
      );
    });

    it('409 на занятый телефон с именем владельца — сотрудник не создан', async () => {
      repository.findByPhone.mockResolvedValue({
        id: OTHER_EMPLOYEE_ID,
        firstName: 'Нигина',
        lastName: 'Каримова',
      });

      await expect(service.create(dto, ACTOR_ACCOUNT_ID)).rejects.toThrow(/Каримова Нигина/);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('занятость проверяется по нормализованному номеру, а не по строке из формы', async () => {
      await service.create({ ...dto, phone: '+992 90 123-45-67' }, ACTOR_ACCOUNT_ID);

      expect(repository.findByPhone).toHaveBeenCalledWith('+992901234567');
    });

    it('422 на несуществующий филиал — сотрудник не создан', async () => {
      repository.findBranch.mockResolvedValue(null);

      await expect(
        service.create({ ...dto, branchId: BRANCH_ID }, ACTOR_ACCOUNT_ID),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('без филиала лишнего запроса в справочник нет', async () => {
      await service.create(dto, ACTOR_ACCOUNT_ID);

      expect(repository.findBranch).not.toHaveBeenCalled();
    });

    it('400 на несуществующую дату (30 февраля)', async () => {
      await expect(
        service.create({ ...dto, birthDate: '1994-02-30' }, ACTOR_ACCOUNT_ID),
      ).rejects.toThrow();
    });

    it('позиции из формы уходят в создание (ТЗ 5.14: Position — мультивыбор)', async () => {
      await service.create({ ...dto, positionIds: [MENTOR_POSITION_ID] }, ACTOR_ACCOUNT_ID);

      expect(repository.create).toHaveBeenCalledWith(expect.any(Object), [MENTOR_POSITION_ID]);
    });
  });

  describe('Позиции в форме требуют права на роли (решение этой сессии)', () => {
    const dto = { firstName: 'Фаррух', lastName: 'Раҳимов', phone: '+992901234567' };

    it('403 без права ManageUserRoles — сотрудник не создан', async () => {
      permissions.hasPermissions.mockResolvedValue(false);

      await expect(
        service.create({ ...dto, positionIds: [MENTOR_POSITION_ID] }, ACTOR_ACCOUNT_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('403 при правке без права — карточка не изменена', async () => {
      permissions.hasPermissions.mockResolvedValue(false);

      await expect(
        service.update(EMPLOYEE_ID, { positionIds: [] }, ACTOR_ACCOUNT_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('право спрашивается для аккаунта вызывающего и именно на управление ролями', async () => {
      await service.create({ ...dto, positionIds: [MENTOR_POSITION_ID] }, ACTOR_ACCOUNT_ID);

      expect(permissions.hasPermissions).toHaveBeenCalledWith(ACTOR_ACCOUNT_ID, [
        'Permission.Administration.ManageUserRoles',
      ]);
    });

    it('форма без позиций права на роли не спрашивает — это обычная правка карточки', async () => {
      await service.update(EMPLOYEE_ID, { telegram: '@new' }, ACTOR_ACCOUNT_ID);

      expect(permissions.hasPermissions).not.toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalled();
    });

    it('422 с перечислением только недостающих позиций', async () => {
      const failure = service.update(
        EMPLOYEE_ID,
        { positionIds: [MENTOR_POSITION_ID, OTHER_EMPLOYEE_ID] },
        ACTOR_ACCOUNT_ID,
      );

      await expect(failure).rejects.toBeInstanceOf(BusinessRuleException);
      await expect(failure).rejects.toMatchObject({
        response: { details: [OTHER_EMPLOYEE_ID] },
      });
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('пустой массив снимает все позиции, а не «не трогает»', async () => {
      await service.update(EMPLOYEE_ID, { positionIds: [] }, ACTOR_ACCOUNT_ID);

      expect(repository.update).toHaveBeenCalledWith(
        EMPLOYEE_ID,
        expect.any(Object),
        [],
        undefined,
      );
    });

    it('не переданное поле позиции не трогает', async () => {
      await service.update(EMPLOYEE_ID, { telegram: '@new' }, ACTOR_ACCOUNT_ID);

      expect(repository.update).toHaveBeenCalledWith(
        EMPLOYEE_ID,
        expect.any(Object),
        undefined,
        undefined,
      );
    });
  });

  describe('Правка карточки', () => {
    it('не переданные поля до БД не доходят — Prisma оставит колонку прежней', async () => {
      await service.update(EMPLOYEE_ID, { telegram: '@new' }, ACTOR_ACCOUNT_ID);

      const input = repository.update.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(input.telegram).toBe('@new');
      expect(input.firstName).toBeUndefined();
      expect(input.phone).toBeUndefined();
      expect(input.status).toBeUndefined();
    });

    it('пустая строка очищает необязательное поле', async () => {
      await service.update(
        EMPLOYEE_ID,
        { experience: '', description: '', middleName: '' },
        ACTOR_ACCOUNT_ID,
      );

      expect(repository.update).toHaveBeenCalledWith(
        EMPLOYEE_ID,
        expect.objectContaining({ experience: null, description: null, middleName: null }),
        undefined,
        undefined,
      );
    });

    it('пустая строка снимает филиал и дату приёма', async () => {
      await service.update(EMPLOYEE_ID, { branchId: '', hiredAt: '' }, ACTOR_ACCOUNT_ID);

      expect(repository.update).toHaveBeenCalledWith(
        EMPLOYEE_ID,
        expect.objectContaining({ branchId: null, hiredAt: null }),
        undefined,
        undefined,
      );
      expect(repository.findBranch).not.toHaveBeenCalled();
    });

    it('свой же телефон конфликтом не считается', async () => {
      repository.findByPhone.mockResolvedValue({
        id: EMPLOYEE_ID,
        firstName: 'Фаррух',
        lastName: 'Раҳимов',
      });

      await expect(
        service.update(EMPLOYEE_ID, { phone: '+992901234567' }, ACTOR_ACCOUNT_ID),
      ).resolves.toMatchObject({ id: EMPLOYEE_ID });
    });

    it('409 на телефон другого сотрудника', async () => {
      repository.findByPhone.mockResolvedValue({
        id: OTHER_EMPLOYEE_ID,
        firstName: 'Нигина',
        lastName: 'Каримова',
      });

      await expect(
        service.update(EMPLOYEE_ID, { phone: '+992901234567' }, ACTOR_ACCOUNT_ID),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('404 до всех проверок', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.update(EMPLOYEE_ID, { phone: '+992909999999' }, ACTOR_ACCOUNT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findByPhone).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('INACTIVE закрывает вход (решение этой сессии)', () => {
    it('перевод в INACTIVE блокирует аккаунт', async () => {
      await service.update(EMPLOYEE_ID, { status: EmployeeStatus.INACTIVE }, ACTOR_ACCOUNT_ID);

      expect(repository.update).toHaveBeenCalledWith(
        EMPLOYEE_ID,
        expect.objectContaining({ status: EmployeeStatus.INACTIVE }),
        undefined,
        AccountStatus.BLOCKED,
      );
    });

    it('возврат в ACTIVE открывает вход обратно', async () => {
      repository.findById.mockResolvedValue(row({ status: EmployeeStatus.INACTIVE }));

      await service.update(EMPLOYEE_ID, { status: EmployeeStatus.ACTIVE }, ACTOR_ACCOUNT_ID);

      expect(repository.update).toHaveBeenCalledWith(
        EMPLOYEE_ID,
        expect.any(Object),
        undefined,
        AccountStatus.ACTIVE,
      );
    });

    it('тот же статус вход не трогает и сессии не гасит', async () => {
      await service.update(EMPLOYEE_ID, { status: EmployeeStatus.ACTIVE }, ACTOR_ACCOUNT_ID);

      expect(repository.update).toHaveBeenCalledWith(
        EMPLOYEE_ID,
        expect.any(Object),
        undefined,
        undefined,
      );
    });

    it('правка без статуса вход не трогает', async () => {
      await service.update(EMPLOYEE_ID, { address: 'ул. Айни, 1' }, ACTOR_ACCOUNT_ID);

      expect(repository.update).toHaveBeenCalledWith(
        EMPLOYEE_ID,
        expect.any(Object),
        undefined,
        undefined,
      );
    });
  });

  describe('Последний действующий Director неприкосновенен (ТЗ 3.2, 5.16)', () => {
    const director = (overrides: Partial<EmployeeRow> = {}): EmployeeRow =>
      row({ positions: [{ position: DIRECTOR_POSITION }], ...overrides });

    beforeEach(() => {
      repository.findById.mockResolvedValue(director());
      repository.findForDeletion.mockResolvedValue(
        deletable({ positions: [{ position: DIRECTOR_POSITION }] }),
      );
    });

    it('422 на снятие позиции у последнего', async () => {
      await expect(
        service.update(EMPLOYEE_ID, { positionIds: [MENTOR_POSITION_ID] }, ACTOR_ACCOUNT_ID),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('422 на вывод последнего из штата — увольнение запирает систему так же', async () => {
      await expect(
        service.update(EMPLOYEE_ID, { status: EmployeeStatus.INACTIVE }, ACTOR_ACCOUNT_ID),
      ).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('422 на удаление последнего', async () => {
      await expect(service.remove(EMPLOYEE_ID)).rejects.toBeInstanceOf(BusinessRuleException);
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('при втором действующем руководителе всё три операции проходят', async () => {
      repository.countPositionHolders.mockResolvedValue(1);

      await expect(
        service.update(EMPLOYEE_ID, { positionIds: [MENTOR_POSITION_ID] }, ACTOR_ACCOUNT_ID),
      ).resolves.toBeDefined();
      await expect(
        service.update(EMPLOYEE_ID, { status: EmployeeStatus.INACTIVE }, ACTOR_ACCOUNT_ID),
      ).resolves.toBeDefined();
      await expect(service.remove(EMPLOYEE_ID)).resolves.toMatchObject({ id: EMPLOYEE_ID });
    });

    it('счётчик спрашивается исключая самого сотрудника', async () => {
      repository.countPositionHolders.mockResolvedValue(1);

      await service.update(EMPLOYEE_ID, { status: EmployeeStatus.INACTIVE }, ACTOR_ACCOUNT_ID);

      expect(repository.countPositionHolders).toHaveBeenCalledWith(
        DIRECTOR_POSITION_ID,
        EMPLOYEE_ID,
      );
    });

    it('сохранение позиции в наборе правило не запускает', async () => {
      await service.update(
        EMPLOYEE_ID,
        { positionIds: [DIRECTOR_POSITION_ID, MENTOR_POSITION_ID] },
        ACTOR_ACCOUNT_ID,
      );

      expect(repository.countPositionHolders).not.toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalled();
    });

    it('уже выведенный из штата руководитель правило не запускает — вход ему и так закрыт', async () => {
      repository.findById.mockResolvedValue(director({ status: EmployeeStatus.INACTIVE }));

      await service.update(EMPLOYEE_ID, { positionIds: [] }, ACTOR_ACCOUNT_ID);

      expect(repository.countPositionHolders).not.toHaveBeenCalled();
    });

    it('обычная позиция под правило не подпадает', async () => {
      repository.findById.mockResolvedValue(row({ positions: [{ position: MENTOR_POSITION }] }));

      await service.update(EMPLOYEE_ID, { positionIds: [] }, ACTOR_ACCOUNT_ID);

      expect(repository.countPositionHolders).not.toHaveBeenCalled();
    });

    it('не системный тёзка «Director» правило не запускает', async () => {
      repository.findById.mockResolvedValue(
        row({
          positions: [{ position: { id: MENTOR_POSITION_ID, name: 'Director', isSystem: false } }],
        }),
      );

      await service.update(EMPLOYEE_ID, { positionIds: [] }, ACTOR_ACCOUNT_ID);

      expect(repository.countPositionHolders).not.toHaveBeenCalled();
    });
  });

  describe('Удаление', () => {
    it('удаляет «чистый» профиль и называет удалённого', async () => {
      expect(await service.remove(EMPLOYEE_ID)).toEqual({
        id: EMPLOYEE_ID,
        fullName: 'Раҳимов Фаррух',
        accountDeleted: false,
      });
      expect(repository.delete).toHaveBeenCalledWith(EMPLOYEE_ID, null);
    });

    it('аккаунт уходит вместе с профилем (ТЗ 3.1)', async () => {
      repository.findForDeletion.mockResolvedValue(deletable({ accountId: ACCOUNT_ID }));

      expect(await service.remove(EMPLOYEE_ID)).toMatchObject({ accountDeleted: true });
      expect(repository.delete).toHaveBeenCalledWith(EMPLOYEE_ID, ACCOUNT_ID);
    });

    it('409 с перечислением того, что держит профиль', async () => {
      repository.findForDeletion.mockResolvedValue(
        deletable({
          _count: {
            mentorGroups: 2,
            mentorSlots: 0,
            submittedWeeks: 5,
            authoredFeedback: 0,
            awardedCoins: 3,
            taughtDays: 0,
            salaries: 0,
          },
        }),
      );

      await expect(service.remove(EMPLOYEE_ID)).rejects.toThrow(
        /группы под менторством \(2\).*недели журнала \(5\).*коинов \(3\)/,
      );
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('о пустых категориях в сообщении не пишется', async () => {
      repository.findForDeletion.mockResolvedValue(
        deletable({
          _count: {
            mentorGroups: 1,
            mentorSlots: 0,
            submittedWeeks: 0,
            authoredFeedback: 0,
            awardedCoins: 0,
            taughtDays: 0,
            salaries: 0,
          },
        }),
      );

      await expect(service.remove(EMPLOYEE_ID)).rejects.toThrow(
        /группы под менторством \(1\)(?!.*\(0\))/,
      );
    });

    it('проведённые занятия и расчёты зарплаты тоже держат профиль (0032)', async () => {
      repository.findForDeletion.mockResolvedValue(
        deletable({
          _count: {
            mentorGroups: 0,
            mentorSlots: 0,
            submittedWeeks: 0,
            authoredFeedback: 0,
            awardedCoins: 0,
            taughtDays: 12,
            salaries: 3,
          },
        }),
      );

      // Удаление обнулило бы ведущего у дней журнала (`SET NULL`), и прошлые
      // ведомости зарплаты молча перестали бы сходиться.
      await expect(service.remove(EMPLOYEE_ID)).rejects.toThrow(
        /проведённые занятия \(12\).*расчёты зарплаты \(3\)/,
      );
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('одного занятия в расписании довольно, чтобы отказать', async () => {
      repository.findForDeletion.mockResolvedValue(
        deletable({
          _count: {
            mentorGroups: 0,
            mentorSlots: 1,
            submittedWeeks: 0,
            authoredFeedback: 0,
            awardedCoins: 0,
            taughtDays: 0,
            salaries: 0,
          },
        }),
      );

      await expect(service.remove(EMPLOYEE_ID)).rejects.toBeInstanceOf(ConflictException);
    });

    it('404 на неизвестного', async () => {
      repository.findForDeletion.mockResolvedValue(null);

      await expect(service.remove(EMPLOYEE_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.delete).not.toHaveBeenCalled();
    });
  });
});

/** Первая строка постраничного ответа — чтобы не повторять индекс в каждом тесте. */
function result0<T>(page: { items: T[] }): T {
  return page.items[0];
}
