import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  AccountStatus,
  AccountType,
  GroupStudentStatus,
  Locale,
  StudentStatus,
} from '@prisma/client';

import type { PasswordResetService } from '../auth/password-reset.service';
import type { PasswordService } from '../auth/password.service';
import { BusinessRuleException } from '../common';
import type { MailerService } from '../mailer';
import type { StudentAccessRow, StudentAccessRepository } from './student-access.repository';
import { StudentAccessService } from './student-access.service';

const STUDENT_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const ACTOR_ID = '33333333-3333-3333-3333-333333333333';

const account = (overrides: Partial<StudentAccessRow['account']> = {}) => ({
  id: ACCOUNT_ID,
  phone: '+992901234567',
  email: 'nigina@mail.tj',
  status: AccountStatus.ACTIVE,
  ...overrides,
});

const student = (overrides: Partial<StudentAccessRow> = {}): StudentAccessRow => ({
  id: STUDENT_ID,
  firstName: 'Нигина',
  lastName: 'Каримова',
  phone: '+992901234567',
  email: 'nigina@mail.tj',
  status: StudentStatus.ACTIVE,
  accountId: null,
  account: null,
  groups: [],
  ...overrides,
});

describe('StudentAccessService', () => {
  let repository: jest.Mocked<
    Pick<
      StudentAccessRepository,
      'findStudent' | 'findAccountByPhoneOrEmail' | 'setBlocked' | 'createAccount'
    >
  >;
  let passwords: jest.Mocked<Pick<PasswordService, 'hash'>>;
  let passwordReset: jest.Mocked<Pick<PasswordResetService, 'issueCode'>>;
  let mailer: jest.Mocked<Pick<MailerService, 'send'>>;
  let service: StudentAccessService;

  beforeEach(() => {
    repository = {
      findStudent: jest.fn().mockResolvedValue(student()),
      findAccountByPhoneOrEmail: jest.fn().mockResolvedValue(null),
      setBlocked: jest.fn().mockResolvedValue({ account: null, revokedSessions: 0 }),
      createAccount: jest.fn().mockResolvedValue(account()),
    };
    passwords = { hash: jest.fn().mockResolvedValue('$argon2id$hash') };
    passwordReset = { issueCode: jest.fn().mockResolvedValue('123456') };
    mailer = { send: jest.fn().mockResolvedValue(undefined) };

    service = new StudentAccessService(
      repository as unknown as StudentAccessRepository,
      passwords as unknown as PasswordService,
      passwordReset as unknown as PasswordResetService,
      mailer,
    );
  });

  describe('Блокировка', () => {
    it('ставит BLOCK профилю и BLOCKED аккаунту одной операцией', async () => {
      repository.findStudent.mockResolvedValue(
        student({ accountId: ACCOUNT_ID, account: account() }),
      );
      repository.setBlocked.mockResolvedValue({
        account: account({ status: AccountStatus.BLOCKED }),
        revokedSessions: 2,
      });

      const result = await service.block(STUDENT_ID, { blocked: true }, ACTOR_ID);

      expect(repository.setBlocked).toHaveBeenCalledWith({
        studentId: STUDENT_ID,
        studentStatus: StudentStatus.BLOCK,
        accountId: ACCOUNT_ID,
        accountStatus: AccountStatus.BLOCKED,
        revokeSessions: true,
      });
      expect(result).toMatchObject({
        id: STUDENT_ID,
        fullName: 'Каримова Нигина',
        blocked: true,
        status: StudentStatus.BLOCK,
        revokedSessions: 2,
      });
    });

    it('студент без логина блокируется тоже — блокируется профиль', async () => {
      const result = await service.block(STUDENT_ID, { blocked: true }, ACTOR_ID);

      expect(repository.setBlocked).toHaveBeenCalledWith(
        expect.objectContaining({
          studentStatus: StudentStatus.BLOCK,
          accountId: null,
          revokeSessions: false,
        }),
      );
      expect(result).toMatchObject({ blocked: true, account: null, revokedSessions: 0 });
    });

    it('повторная блокировка не переписывает уже выставленные статусы', async () => {
      repository.findStudent.mockResolvedValue(
        student({
          status: StudentStatus.BLOCK,
          accountId: ACCOUNT_ID,
          account: account({ status: AccountStatus.BLOCKED }),
        }),
      );

      await service.block(STUDENT_ID, { blocked: true }, ACTOR_ID);

      expect(repository.setBlocked).toHaveBeenCalledWith(
        expect.objectContaining({ studentStatus: undefined, accountStatus: undefined }),
      );
    });

    it('но сессии при повторной блокировке всё равно гасятся', async () => {
      repository.findStudent.mockResolvedValue(
        student({
          status: StudentStatus.BLOCK,
          accountId: ACCOUNT_ID,
          account: account({ status: AccountStatus.BLOCKED }),
        }),
      );

      await service.block(STUDENT_ID, { blocked: true }, ACTOR_ID);

      expect(repository.setBlocked).toHaveBeenCalledWith(
        expect.objectContaining({ revokeSessions: true }),
      );
    });
  });

  describe('Разблокировка', () => {
    it('открывает вход и возвращает статус учащегося', async () => {
      repository.findStudent.mockResolvedValue(
        student({
          status: StudentStatus.BLOCK,
          accountId: ACCOUNT_ID,
          account: account({ status: AccountStatus.BLOCKED }),
          groups: [{ status: GroupStudentStatus.ACTIVE, statusChangedAt: null }],
        }),
      );

      const result = await service.block(STUDENT_ID, { blocked: false }, ACTOR_ID);

      expect(repository.setBlocked).toHaveBeenCalledWith(
        expect.objectContaining({
          studentStatus: StudentStatus.ACTIVE,
          accountStatus: AccountStatus.ACTIVE,
          revokeSessions: false,
        }),
      );
      expect(result).toMatchObject({ blocked: false, status: StudentStatus.ACTIVE });
    });

    it('покинувшего курс возвращает в NO_ACTIVE, а не в ACTIVE', async () => {
      repository.findStudent.mockResolvedValue(
        student({
          status: StudentStatus.BLOCK,
          groups: [
            {
              status: GroupStudentStatus.LEFT,
              statusChangedAt: new Date('2026-05-01T00:00:00.000Z'),
            },
          ],
        }),
      );

      const result = await service.block(STUDENT_ID, { blocked: false }, ACTOR_ID);

      expect(result.status).toBe(StudentStatus.NO_ACTIVE);
    });

    it('профиль без учебной истории возвращается в ACTIVE', async () => {
      repository.findStudent.mockResolvedValue(student({ status: StudentStatus.BLOCK }));

      const result = await service.block(STUDENT_ID, { blocked: false }, ACTOR_ID);

      expect(result.status).toBe(StudentStatus.ACTIVE);
    });

    it('не трогает статус профиля, который блокировкой не помечен', async () => {
      repository.findStudent.mockResolvedValue(
        student({
          status: StudentStatus.FINISHED,
          accountId: ACCOUNT_ID,
          account: account({ status: AccountStatus.BLOCKED }),
        }),
      );

      const result = await service.block(STUDENT_ID, { blocked: false }, ACTOR_ID);

      expect(repository.setBlocked).toHaveBeenCalledWith(
        expect.objectContaining({
          studentStatus: undefined,
          accountStatus: AccountStatus.ACTIVE,
        }),
      );
      expect(result.status).toBe(StudentStatus.FINISHED);
    });

    it('404 на неизвестного студента — до записи', async () => {
      repository.findStudent.mockResolvedValue(null);

      await expect(service.block(STUDENT_ID, { blocked: true }, ACTOR_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.setBlocked).not.toHaveBeenCalled();
    });
  });

  describe('Приглашение', () => {
    it('заводит аккаунт с телефоном-логином и шлёт код на почту карточки', async () => {
      const result = await service.invite(STUDENT_ID, {}, ACTOR_ID);

      expect(repository.createAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          studentId: STUDENT_ID,
          phone: '+992901234567',
          email: 'nigina@mail.tj',
          locale: Locale.RU,
          updateStudentEmail: false,
        }),
      );
      expect(passwordReset.issueCode).toHaveBeenCalledWith(ACCOUNT_ID);
      expect(mailer.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'nigina@mail.tj', text: expect.stringContaining('123456') }),
      );
      expect(result).toMatchObject({
        id: STUDENT_ID,
        fullName: 'Каримова Нигина',
        codeSentTo: 'nigina@mail.tj',
      });
    });

    it('пароль не придумывается: в аккаунт кладётся хеш случайного секрета', async () => {
      await service.invite(STUDENT_ID, {}, ACTOR_ID);

      const secret = passwords.hash.mock.calls[0]?.[0];
      expect(secret).toEqual(expect.any(String));
      expect(secret.length).toBeGreaterThan(32);
      expect(repository.createAccount).toHaveBeenCalledWith(
        expect.objectContaining({ passwordHash: '$argon2id$hash' }),
      );
      // Секрет никуда не возвращается — знать его не должен никто, включая
      // сотрудника, который приглашает.
      expect(JSON.stringify(await service.invite(STUDENT_ID, {}, ACTOR_ID))).not.toContain(secret);
    });

    it('письмо уходит на языке из запроса (ТЗ 3.3)', async () => {
      await service.invite(STUDENT_ID, { locale: Locale.TG }, ACTOR_ID);

      expect(repository.createAccount).toHaveBeenCalledWith(
        expect.objectContaining({ locale: Locale.TG }),
      );
      expect(mailer.send).toHaveBeenCalledWith(
        expect.objectContaining({ subject: expect.stringContaining('CRM Omuz') }),
      );
    });

    it('почта из тела записывается и в карточку студента', async () => {
      await service.invite(STUDENT_ID, { email: 'new@mail.tj' }, ACTOR_ID);

      expect(repository.createAccount).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'new@mail.tj', updateStudentEmail: true }),
      );
    });

    it('та же почта в теле лишней правкой карточки не оборачивается', async () => {
      await service.invite(STUDENT_ID, { email: 'nigina@mail.tj' }, ACTOR_ID);

      expect(repository.createAccount).toHaveBeenCalledWith(
        expect.objectContaining({ updateStudentEmail: false }),
      );
    });

    it('422 без почты: приглашение отправляется письмом', async () => {
      repository.findStudent.mockResolvedValue(student({ email: null }));

      await expect(service.invite(STUDENT_ID, {}, ACTOR_ID)).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
      expect(repository.createAccount).not.toHaveBeenCalled();
    });

    it('без почты в карточке приглашает по адресу из тела', async () => {
      repository.findStudent.mockResolvedValue(student({ email: null }));

      await service.invite(STUDENT_ID, { email: 'new@mail.tj' }, ACTOR_ID);

      expect(repository.createAccount).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'new@mail.tj', updateStudentEmail: true }),
      );
    });

    it('409 на повторное приглашение — логин уже есть', async () => {
      repository.findStudent.mockResolvedValue(
        student({ accountId: ACCOUNT_ID, account: account() }),
      );

      await expect(service.invite(STUDENT_ID, {}, ACTOR_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(repository.createAccount).not.toHaveBeenCalled();
    });

    it('422 на заблокированного: свежий аккаунт снял бы блокировку', async () => {
      repository.findStudent.mockResolvedValue(student({ status: StudentStatus.BLOCK }));

      await expect(service.invite(STUDENT_ID, {}, ACTOR_ID)).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
      expect(repository.createAccount).not.toHaveBeenCalled();
    });

    it('409 с указанием телефона, если он уже чей-то логин', async () => {
      repository.findAccountByPhoneOrEmail.mockResolvedValue({
        id: 'other',
        phone: '+992901234567',
        email: 'other@mail.tj',
        type: AccountType.EMPLOYEE,
      });

      await expect(service.invite(STUDENT_ID, {}, ACTOR_ID)).rejects.toThrow(/Телефон/);
      expect(repository.createAccount).not.toHaveBeenCalled();
    });

    it('409 с указанием почты, если занята она', async () => {
      repository.findAccountByPhoneOrEmail.mockResolvedValue({
        id: 'other',
        phone: '+992900000000',
        email: 'nigina@mail.tj',
        type: AccountType.STUDENT,
      });

      await expect(service.invite(STUDENT_ID, {}, ACTOR_ID)).rejects.toThrow(/Email/);
    });

    it('404 на неизвестного студента — до поиска занятых логинов', async () => {
      repository.findStudent.mockResolvedValue(null);

      await expect(service.invite(STUDENT_ID, {}, ACTOR_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.findAccountByPhoneOrEmail).not.toHaveBeenCalled();
    });
  });
});
