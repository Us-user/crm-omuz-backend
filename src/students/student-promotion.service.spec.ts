import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AccountStatus, AccountType, EmployeeStatus, Gender } from '@prisma/client';

import { BusinessRuleException } from '../common';
import type { AppConfigService } from '../config';
import { PhoneService } from '../phone';
import { StudentPromotionService } from './student-promotion.service';
import type {
  PromotedEmployee,
  PromoteStudentInput,
  PromoteStudentResult,
  StudentForPromotion,
  StudentsRepository,
} from './students.repository';

const STUDENT_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const EMPLOYEE_ID = '33333333-3333-3333-3333-333333333333';
const PHONE = '+992901234567';

const student = (overrides: Partial<StudentForPromotion> = {}): StudentForPromotion => ({
  id: STUDENT_ID,
  accountId: ACCOUNT_ID,
  firstName: 'Фаррух',
  lastName: 'Раҳимов',
  birthDate: new Date('2004-05-12T00:00:00.000Z'),
  gender: Gender.MALE,
  address: 'г. Душанбе, ул. Рудаки, 25',
  email: 'farrukh@example.tj',
  phone: PHONE,
  telegram: '@farrukh',
  photoUrl: null,
  branchId: null,
  promotedEmployee: null,
  account: {
    id: ACCOUNT_ID,
    phone: PHONE,
    email: 'farrukh@example.tj',
    type: AccountType.STUDENT,
    status: AccountStatus.ACTIVE,
  },
  ...overrides,
});

const employee = (overrides: Partial<PromotedEmployee> = {}): PromotedEmployee => ({
  id: EMPLOYEE_ID,
  accountId: ACCOUNT_ID,
  formerStudentId: STUDENT_ID,
  firstName: 'Фаррух',
  lastName: 'Раҳимов',
  middleName: null,
  phone: PHONE,
  email: 'farrukh@example.tj',
  status: EmployeeStatus.ACTIVE,
  hiredAt: new Date('2026-08-01T00:00:00.000Z'),
  ...overrides,
});

describe('StudentPromotionService', () => {
  let repository: jest.Mocked<StudentsRepository>;
  let service: StudentPromotionService;

  /** Аргументы, с которыми сервис позвал репозиторий на последнем переводе. */
  const promotionCall = (): PromoteStudentInput => {
    const [input] = repository.promoteToEmployee.mock.calls.at(-1) ?? [];
    if (!input) throw new Error('Перевод не выполнялся');
    return input;
  };

  beforeEach(() => {
    const result: PromoteStudentResult = {
      employee: employee(),
      account: {
        id: ACCOUNT_ID,
        phone: PHONE,
        email: 'farrukh@example.tj',
        type: AccountType.EMPLOYEE,
        status: AccountStatus.ACTIVE,
      },
      revokedSessions: 2,
    };

    repository = {
      findForPromotion: jest.fn().mockResolvedValue(student()),
      findEmployeeByPhone: jest.fn().mockResolvedValue(null),
      promoteToEmployee: jest.fn().mockResolvedValue(result),
    } as unknown as jest.Mocked<StudentsRepository>;

    const phones = new PhoneService({ defaultPhoneRegion: 'TJ' } as AppConfigService);
    service = new StudentPromotionService(repository, phones);
  });

  it('создаёт профиль сотрудника из профиля студента и связывает их', async () => {
    const response = await service.promoteToEmployee(STUDENT_ID, {});

    expect(promotionCall()).toMatchObject({
      studentId: STUDENT_ID,
      accountId: ACCOUNT_ID,
      employee: {
        firstName: 'Фаррух',
        lastName: 'Раҳимов',
        birthDate: new Date('2004-05-12T00:00:00.000Z'),
        gender: Gender.MALE,
        address: 'г. Душанбе, ул. Рудаки, 25',
        email: 'farrukh@example.tj',
        phone: PHONE,
        telegram: '@farrukh',
      },
    });

    // Учебная история остаётся на студенте — сотрудник хранит ссылку на неё (ТЗ 3.1).
    expect(response.employee.formerStudentId).toBe(STUDENT_ID);
  });

  it('переносит филиал: место работы у человека то же, где он учился (ТЗ 3.3)', async () => {
    const branchId = '44444444-4444-4444-4444-444444444444';
    repository.findForPromotion.mockResolvedValue(student({ branchId }));

    await service.promoteToEmployee(STUDENT_ID, {});

    expect(promotionCall().employee.branchId).toBe(branchId);
  });

  it('студент без филиала становится сотрудником без филиала, а не падает', async () => {
    await service.promoteToEmployee(STUDENT_ID, {});

    expect(promotionCall().employee.branchId).toBeNull();
  });

  it('не меняет логин: телефон и email аккаунта остаются прежними (ТЗ 3.1)', async () => {
    const response = await service.promoteToEmployee(STUDENT_ID, {});

    expect(response.account).toMatchObject({
      id: ACCOUNT_ID,
      phone: PHONE,
      email: 'farrukh@example.tj',
      type: AccountType.EMPLOYEE,
    });
  });

  it('сообщает, сколько сессий погашено: токен со старым типом жить не должен', async () => {
    const response = await service.promoteToEmployee(STUDENT_ID, {});

    expect(response.revokedSessions).toBe(2);
  });

  it('переводит и студента без аккаунта (ТЗ 5.3: аккаунт опционален)', async () => {
    repository.findForPromotion.mockResolvedValue(student({ accountId: null, account: null }));
    repository.promoteToEmployee.mockResolvedValue({
      employee: employee({ accountId: null }),
      account: null,
      revokedSessions: 0,
    });

    const response = await service.promoteToEmployee(STUDENT_ID, {});

    expect(promotionCall().accountId).toBeNull();
    expect(response.account).toBeNull();
    expect(response.revokedSessions).toBe(0);
  });

  it('отвечает 404 на неизвестного студента', async () => {
    repository.findForPromotion.mockResolvedValue(null);

    await expect(service.promoteToEmployee(STUDENT_ID, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repository.promoteToEmployee).not.toHaveBeenCalled();
  });

  it('отвечает 409 на повторный перевод одного и того же студента', async () => {
    repository.findForPromotion.mockResolvedValue(
      student({ promotedEmployee: { id: EMPLOYEE_ID } }),
    );

    await expect(service.promoteToEmployee(STUDENT_ID, {})).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repository.promoteToEmployee).not.toHaveBeenCalled();
  });

  it('отвечает 409, если сотрудник с таким телефоном уже заведён', async () => {
    repository.findEmployeeByPhone.mockResolvedValue({ id: 'другой-сотрудник' });

    await expect(service.promoteToEmployee(STUDENT_ID, {})).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repository.promoteToEmployee).not.toHaveBeenCalled();
  });

  it('отвечает 422, если аккаунт уже принадлежит сотруднику', async () => {
    repository.findForPromotion.mockResolvedValue(
      student({
        account: {
          id: ACCOUNT_ID,
          phone: PHONE,
          email: 'farrukh@example.tj',
          type: AccountType.EMPLOYEE,
          status: AccountStatus.ACTIVE,
        },
      }),
    );

    await expect(service.promoteToEmployee(STUDENT_ID, {})).rejects.toBeInstanceOf(
      BusinessRuleException,
    );
  });

  it('нормализует рабочий телефон из тела запроса в E.164', async () => {
    await service.promoteToEmployee(STUDENT_ID, { phone: '93 765 43 21' });

    expect(promotionCall().employee.phone).toBe('+992937654321');
    // Занятость проверяется по нормализованному номеру, иначе запись в другом
    // формате прошла бы мимо проверки и упала уникальным индексом.
    expect(repository.findEmployeeByPhone).toHaveBeenCalledWith('+992937654321');
  });

  it('без рабочего телефона берёт контактный телефон студента', async () => {
    await service.promoteToEmployee(STUDENT_ID, {});

    expect(promotionCall().employee.phone).toBe(PHONE);
  });

  it('отвечает 400 на номер, который не является телефоном', async () => {
    await expect(service.promoteToEmployee(STUDENT_ID, { phone: '12345' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('берёт дату приёма из запроса, а без неё — сегодняшний день', async () => {
    await service.promoteToEmployee(STUDENT_ID, { hiredAt: '2026-08-01' });
    expect(promotionCall().employee.hiredAt).toEqual(new Date('2026-08-01T00:00:00.000Z'));

    await service.promoteToEmployee(STUDENT_ID, {});
    expect(promotionCall().employee.hiredAt).toEqual(
      new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z'),
    );
  });

  it('отвергает несуществующую дату приёма', async () => {
    // `new Date` молча перенесла бы 30 февраля на 1 марта.
    await expect(
      service.promoteToEmployee(STUDENT_ID, { hiredAt: '2026-02-30' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('переносит отчество, опыт и описание из тела запроса', async () => {
    await service.promoteToEmployee(STUDENT_ID, {
      middleName: 'Саидович',
      experience: '2 года наставничества',
      description: 'Выпускник курса Frontend',
    });

    expect(promotionCall().employee).toMatchObject({
      middleName: 'Саидович',
      experience: '2 года наставничества',
      description: 'Выпускник курса Frontend',
    });
  });
});
