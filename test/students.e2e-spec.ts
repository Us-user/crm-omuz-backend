import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus, AccountType, EmployeeStatus, Gender } from '@prisma/client';
import request from 'supertest';

import { AuthModule } from 'src/auth/auth.module';
import { AuthRepository } from 'src/auth/auth.repository';
import { TokenService } from 'src/auth/token.service';
import { configureApp } from 'src/bootstrap';
import { AllExceptionsFilter, TransformResponseInterceptor } from 'src/common';
import { AppConfigModule } from 'src/config/config.module';
import { LoggerModule } from 'src/logger/logger.module';
import { MailerModule } from 'src/mailer/mailer.module';
import { PhoneModule } from 'src/phone/phone.module';
import { RbacRepository } from 'src/rbac/rbac.repository';
import { RbacModule } from 'src/rbac/rbac.module';
import type {
  PromotedEmployee,
  PromoteStudentInput,
  PromoteStudentResult,
  StudentForPromotion,
} from 'src/students';
import { StudentsRepository } from 'src/students/students.repository';
import { StudentsModule } from 'src/students/students.module';

/**
 * Перевод Студент → Сотрудник по полному HTTP-пути: пайпы → guard'ы →
 * сервис → интерцептор/фильтр. Вместо PostgreSQL — хранилище в памяти,
 * повторяющее наблюдаемое поведение транзакции (отвязку аккаунта,
 * смену типа и гашение сессий). Сами Prisma-запросы проверяются на реальной БД.
 */
class InMemoryStudentsRepository {
  private readonly students = new Map<string, StudentForPromotion>();
  private readonly employees = new Map<string, PromotedEmployee>();
  /** Сколько живых сессий у аккаунта — перевод обязан их погасить. */
  private readonly liveSessions = new Map<string, number>();

  addStudent(student: StudentForPromotion, liveSessions = 0): StudentForPromotion {
    this.students.set(student.id, student);
    if (student.accountId !== null) this.liveSessions.set(student.accountId, liveSessions);

    return student;
  }

  addEmployee(employee: PromotedEmployee): void {
    this.employees.set(employee.id, employee);
  }

  /** Состояние студента после перевода — проверяем, что история осталась на месте. */
  student(id: string): StudentForPromotion | undefined {
    return this.students.get(id);
  }

  findForPromotion(id: string): Promise<StudentForPromotion | null> {
    return Promise.resolve(this.students.get(id) ?? null);
  }

  findEmployeeByPhone(phone: string): Promise<{ id: string } | null> {
    const found = [...this.employees.values()].find((e) => e.phone === phone);
    return Promise.resolve(found ? { id: found.id } : null);
  }

  promoteToEmployee(input: PromoteStudentInput): Promise<PromoteStudentResult> {
    const student = this.students.get(input.studentId);
    if (!student) throw new Error('Студент не найден: тест построен неверно');

    const employee: PromotedEmployee = {
      id: randomUUID(),
      accountId: input.accountId,
      formerStudentId: input.studentId,
      firstName: input.employee.firstName,
      lastName: input.employee.lastName,
      middleName: input.employee.middleName ?? null,
      phone: input.employee.phone,
      email: input.employee.email,
      status: EmployeeStatus.ACTIVE,
      hiredAt: input.employee.hiredAt,
    };
    this.employees.set(employee.id, employee);

    // Профиль студента остаётся, но перестаёт быть привязанным к аккаунту.
    const account = student.account;
    student.accountId = null;
    student.account = null;
    student.promotedEmployee = { id: employee.id };

    if (input.accountId === null || !account) {
      return Promise.resolve({ employee, account: null, revokedSessions: 0 });
    }

    const revokedSessions = this.liveSessions.get(input.accountId) ?? 0;
    this.liveSessions.set(input.accountId, 0);

    return Promise.resolve({
      employee,
      account: { ...account, type: AccountType.EMPLOYEE },
      revokedSessions,
    });
  }
}

/**
 * Права аккаунта в памяти вместо таблиц `permissions`/`positions`.
 * Синхронизация каталога при старте здесь холостая — она проверяется юнит-тестами.
 */
class InMemoryRbacRepository {
  private readonly granted = new Map<string, string[]>();

  grant(accountId: string, ...codes: string[]): void {
    this.granted.set(accountId, codes);
  }

  findAccountPermissionCodes(accountId: string): Promise<{ code: string }[]> {
    return Promise.resolve((this.granted.get(accountId) ?? []).map((code) => ({ code })));
  }

  findAllPermissions(): Promise<[]> {
    return Promise.resolve([]);
  }

  createPermissions(): Promise<number> {
    return Promise.resolve(0);
  }

  updatePermission(): Promise<void> {
    return Promise.resolve();
  }

  syncSystemPosition(): Promise<number> {
    return Promise.resolve(0);
  }
}

const STUDENT_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const STUDENT_PHONE = '+992901234567';

const student = (overrides: Partial<StudentForPromotion> = {}): StudentForPromotion => ({
  id: STUDENT_ID,
  accountId: ACCOUNT_ID,
  firstName: 'Фаррух',
  lastName: 'Раҳимов',
  birthDate: new Date('2004-05-12T00:00:00.000Z'),
  gender: Gender.MALE,
  address: 'г. Душанбе, ул. Рудаки, 25',
  email: 'farrukh@example.tj',
  phone: STUDENT_PHONE,
  telegram: '@farrukh',
  photoUrl: null,
  branchId: null,
  promotedEmployee: null,
  account: {
    id: ACCOUNT_ID,
    phone: STUDENT_PHONE,
    email: 'farrukh@example.tj',
    type: AccountType.STUDENT,
    status: AccountStatus.ACTIVE,
  },
  ...overrides,
});

describe('Студенты: перевод в сотрудники (e2e, хранилище в памяти)', () => {
  let app: INestApplication;
  let repository: InMemoryStudentsRepository;
  let employeeToken: string;
  let strangerToken: string;
  let studentToken: string;

  const url = (id: string) => `/api/v1/students/${id}/promote-to-employee`;

  beforeEach(async () => {
    repository = new InMemoryStudentsRepository();
    const rbac = new InMemoryRbacRepository();

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        LoggerModule,
        MailerModule,
        PhoneModule,
        AuthModule,
        RbacModule,
        StudentsModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: TransformResponseInterceptor },
      ],
    })
      // AuthModule нужен целиком: он приносит глобальный `JwtAuthGuard`.
      // Репозитории подменяем, чтобы не тянуть Prisma.
      .overrideProvider(AuthRepository)
      .useValue({})
      .overrideProvider(StudentsRepository)
      .useValue(repository)
      .overrideProvider(RbacRepository)
      .useValue(rbac)
      .compile();

    const tokens = moduleRef.get(TokenService, { strict: false });

    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();

    // Токены выпускаются напрямую: проверяется перевод, а не вход.
    const issue = async (type: AccountType, sub = randomUUID()): Promise<string> =>
      (await tokens.issuePair({ sub, sid: randomUUID(), type })).accessToken;

    // Сотрудник с нужным правом, сотрудник вообще без прав и студент —
    // три разных исхода на одном и том же эндпоинте.
    const employeeAccountId = randomUUID();
    rbac.grant(employeeAccountId, 'Permission.Students.Promote');

    employeeToken = await issue(AccountType.EMPLOYEE, employeeAccountId);
    strangerToken = await issue(AccountType.EMPLOYEE);
    studentToken = await issue(AccountType.STUDENT);
  });

  afterEach(async () => {
    await app?.close();
  });

  const promote = (id = STUDENT_ID, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post(url(id))
      .set('Authorization', `Bearer ${employeeToken}`)
      .send(body);

  describe('Доступ', () => {
    it('без access-токена — 401', async () => {
      repository.addStudent(student());

      await request(app.getHttpServer()).post(url(STUDENT_ID)).send({}).expect(401);
    });

    it('студент не может повысить себя до сотрудника — 403 (ТЗ 3.2)', async () => {
      repository.addStudent(student());

      const response = await request(app.getHttpServer())
        .post(url(STUDENT_ID))
        .set('Authorization', `Bearer ${studentToken}`)
        .send({})
        .expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('сотрудник без права Permission.Students.Promote — 403 (ТЗ 3.2, 3.8)', async () => {
      repository.addStudent(student());

      const response = await request(app.getHttpServer())
        .post(url(STUDENT_ID))
        .set('Authorization', `Bearer ${strangerToken}`)
        .send({})
        .expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
      // Отказ до бизнес-логики: перевод не должен был начаться.
      expect(repository.student(STUDENT_ID)?.accountId).toBe(ACCOUNT_ID);
    });
  });

  describe('Успешный перевод', () => {
    it('создаёт профиль сотрудника из данных студента и отдаёт { data }', async () => {
      repository.addStudent(student(), 2);

      const response = await promote().expect(201);

      expect(response.body.data.employee).toMatchObject({
        firstName: 'Фаррух',
        lastName: 'Раҳимов',
        email: 'farrukh@example.tj',
        phone: STUDENT_PHONE,
        status: EmployeeStatus.ACTIVE,
        formerStudentId: STUDENT_ID,
      });
    });

    it('не меняет логин: телефон и email прежние, тип аккаунта — EMPLOYEE (ТЗ 3.1)', async () => {
      repository.addStudent(student(), 2);

      const response = await promote().expect(201);

      expect(response.body.data.account).toEqual({
        id: ACCOUNT_ID,
        phone: STUDENT_PHONE,
        email: 'farrukh@example.tj',
        type: AccountType.EMPLOYEE,
        status: AccountStatus.ACTIVE,
      });
    });

    it('сохраняет профиль студента и гасит сессии старого типа', async () => {
      repository.addStudent(student(), 2);

      const response = await promote().expect(201);

      expect(response.body.data.revokedSessions).toBe(2);

      // Учебная история никуда не делась — профиль лишь отвязан от аккаунта.
      const saved = repository.student(STUDENT_ID);
      expect(saved).toMatchObject({ id: STUDENT_ID, firstName: 'Фаррух', accountId: null });
      expect(saved?.promotedEmployee).not.toBeNull();
    });

    it('переводит студента без аккаунта (ТЗ 5.3: аккаунт опционален)', async () => {
      repository.addStudent(student({ accountId: null, account: null }));

      const response = await promote().expect(201);

      expect(response.body.data.account).toBeNull();
      expect(response.body.data.revokedSessions).toBe(0);
    });

    it('нормализует рабочий телефон и принимает дату приёма', async () => {
      repository.addStudent(student());

      const response = await promote(STUDENT_ID, {
        phone: '93 765 43 21',
        middleName: 'Саидович',
        hiredAt: '2026-08-01',
      }).expect(201);

      expect(response.body.data.employee).toMatchObject({
        phone: '+992937654321',
        middleName: 'Саидович',
        hiredAt: '2026-08-01',
      });
    });
  });

  describe('Отказы', () => {
    it('404 на неизвестного студента', async () => {
      const response = await promote(randomUUID()).expect(404);

      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('400, если идентификатор не UUID', async () => {
      const response = await promote('не-uuid').expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('409 на повторный перевод того же студента', async () => {
      repository.addStudent(student());

      await promote().expect(201);
      const response = await promote().expect(409);

      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('409, если сотрудник с таким телефоном уже заведён', async () => {
      repository.addStudent(student());
      repository.addEmployee({
        id: randomUUID(),
        accountId: null,
        formerStudentId: null,
        firstName: 'Другой',
        lastName: 'Сотрудник',
        middleName: null,
        phone: STUDENT_PHONE,
        email: null,
        status: EmployeeStatus.ACTIVE,
        hiredAt: null,
      });

      const response = await promote().expect(409);

      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('400 на лишнее поле в теле запроса', async () => {
      repository.addStudent(student());

      const response = await promote(STUDENT_ID, { positionId: 'director' }).expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('400 на несуществующую дату приёма', async () => {
      repository.addStudent(student());

      await promote(STUDENT_ID, { hiredAt: '2026-02-30' }).expect(400);
    });
  });
});
