import { ForbiddenException } from '@nestjs/common';
import { AccountStatus, AccountType, Locale } from '@prisma/client';
import type { PasswordResetCode } from '@prisma/client';

import { BusinessRuleException } from '../common';
import type { AppConfigService } from '../config';
import type { MailerService } from '../mailer';
import {
  PASSWORD_RESET_MAX_ATTEMPTS,
  PASSWORD_RESET_MAX_REQUESTS_PER_HOUR,
  PASSWORD_RESET_TTL_SECONDS,
} from './auth.constants';
import type { AccountWithProfile, AuthRepository } from './auth.repository';
import type { PasswordService } from './password.service';
import { PasswordResetService } from './password-reset.service';
import { ResetCodeService } from './reset-code.service';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const CODE_ID = '33333333-3333-3333-3333-333333333333';
const EMAIL = 'farrukh@example.tj';

const account = (overrides: Partial<AccountWithProfile> = {}): AccountWithProfile => ({
  id: ACCOUNT_ID,
  phone: '+992901234567',
  email: EMAIL,
  passwordHash: 'hashed:старый-пароль',
  type: AccountType.STUDENT,
  status: AccountStatus.ACTIVE,
  locale: Locale.RU,
  student: { id: 'student-1', firstName: 'Фаррух', lastName: 'Раҳимов' },
  employee: null,
  ...overrides,
});

const resetCode = (overrides: Partial<PasswordResetCode> = {}): PasswordResetCode => ({
  id: CODE_ID,
  accountId: ACCOUNT_ID,
  codeHash: 'заменяется в тестах',
  attempts: 0,
  expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000),
  consumedAt: null,
  createdAt: new Date(),
  ...overrides,
});

describe('PasswordResetService', () => {
  let repository: jest.Mocked<AuthRepository>;
  let passwords: jest.Mocked<PasswordService>;
  let mailer: jest.Mocked<MailerService>;
  let codes: ResetCodeService;
  let service: PasswordResetService;

  beforeEach(() => {
    repository = {
      findAccountByEmail: jest.fn().mockResolvedValue(account()),
      countPasswordResetCodesSince: jest.fn().mockResolvedValue(0),
      consumeActivePasswordResetCodes: jest.fn().mockResolvedValue(0),
      createPasswordResetCode: jest.fn().mockResolvedValue(resetCode()),
      findActivePasswordResetCode: jest.fn().mockResolvedValue(null),
      registerPasswordResetAttempt: jest.fn().mockResolvedValue(undefined),
      completePasswordReset: jest.fn().mockResolvedValue(2),
    } as unknown as jest.Mocked<AuthRepository>;

    passwords = {
      hash: jest.fn((plain: string) => Promise.resolve(`hashed:${plain}`)),
    } as unknown as jest.Mocked<PasswordService>;

    mailer = { send: jest.fn().mockResolvedValue(undefined) };

    codes = new ResetCodeService({
      passwordResetSecret: 'secret-at-least-32-characters-long!!',
    } as AppConfigService);

    service = new PasswordResetService(repository, passwords, codes, mailer);
  });

  /** Достаёт код из отправленного письма — так же, как его прочитает пользователь. */
  const sentCode = (): string => {
    const [message] = mailer.send.mock.calls.at(-1) ?? [];
    const found = /\b(\d{6})\b/.exec(message?.text ?? '');
    if (!found) throw new Error('В письме нет шестизначного кода');
    return found[1];
  };

  /** Возвращает код, выпущенный сервисом, и подставляет его в хранилище как активный. */
  const requestCode = async (): Promise<string> => {
    await service.forgot({ email: EMAIL });

    const [created] = repository.createPasswordResetCode.mock.calls.at(-1) ?? [];
    repository.findActivePasswordResetCode.mockResolvedValue(
      resetCode({ codeHash: created?.codeHash ?? '' }),
    );

    return sentCode();
  };

  describe('forgot', () => {
    it('отправляет письмо с шестизначным кодом и сохраняет его хеш', async () => {
      const response = await service.forgot({ email: EMAIL });

      expect(mailer.send).toHaveBeenCalledTimes(1);
      expect(response.message).toEqual(expect.any(String));

      const [created] = repository.createPasswordResetCode.mock.calls[0];
      expect(created.accountId).toBe(ACCOUNT_ID);
      expect(codes.matches(sentCode(), ACCOUNT_ID, created.codeHash)).toBe(true);
    });

    it('не кладёт сам код в базу — только хеш', async () => {
      await service.forgot({ email: EMAIL });

      const [created] = repository.createPasswordResetCode.mock.calls[0];
      expect(created.codeHash).not.toContain(sentCode());
    });

    it('ставит сроком жизни 10 минут (ТЗ 3.1)', async () => {
      const before = Date.now();
      await service.forgot({ email: EMAIL });

      const [created] = repository.createPasswordResetCode.mock.calls[0];
      const ttlMs = created.expiresAt.getTime() - before;

      expect(ttlMs).toBeGreaterThan((PASSWORD_RESET_TTL_SECONDS - 5) * 1000);
      expect(ttlMs).toBeLessThanOrEqual((PASSWORD_RESET_TTL_SECONDS + 5) * 1000);
    });

    it('гасит прежние коды, чтобы живым оставался только последний', async () => {
      await service.forgot({ email: EMAIL });

      expect(repository.consumeActivePasswordResetCodes).toHaveBeenCalledWith(ACCOUNT_ID);
    });

    it('на неизвестный email отвечает так же, но письмо не шлёт', async () => {
      repository.findAccountByEmail.mockResolvedValue(null);

      const unknown = await service.forgot({ email: 'нет-такого@example.tj' });

      expect(mailer.send).not.toHaveBeenCalled();
      expect(repository.createPasswordResetCode).not.toHaveBeenCalled();
      // Тот же текст, что и для существующего аккаунта: иначе эндпоинт
      // работает как проверка «кто зарегистрирован».
      repository.findAccountByEmail.mockResolvedValue(account());
      const known = await service.forgot({ email: EMAIL });
      expect(unknown.message).toBe(known.message);
    });

    it('не шлёт код заблокированному аккаунту: сброс не должен обходить блокировку', async () => {
      repository.findAccountByEmail.mockResolvedValue(account({ status: AccountStatus.BLOCKED }));

      await service.forgot({ email: EMAIL });

      expect(mailer.send).not.toHaveBeenCalled();
    });

    it(`перестаёт слать письма после ${String(PASSWORD_RESET_MAX_REQUESTS_PER_HOUR)} запросов в час (ТЗ 3.1)`, async () => {
      repository.countPasswordResetCodesSince.mockResolvedValue(
        PASSWORD_RESET_MAX_REQUESTS_PER_HOUR,
      );

      const response = await service.forgot({ email: EMAIL });

      expect(mailer.send).not.toHaveBeenCalled();
      // Ответ прежний: 429 выдал бы, что аккаунт существует.
      expect(response.message).toEqual(expect.any(String));
    });

    it('шлёт письмо на языке аккаунта (ТЗ 3.3)', async () => {
      repository.findAccountByEmail.mockResolvedValue(account({ locale: Locale.EN }));
      await service.forgot({ email: EMAIL });

      expect(mailer.send.mock.calls[0][0].subject).toBe('Password reset — CRM Omuz');
    });
  });

  describe('reset', () => {
    it('меняет пароль по верному коду и гасит все сессии', async () => {
      const code = await requestCode();

      const response = await service.reset({ email: EMAIL, code, newPassword: 'новый-пароль-1' });

      expect(response).toEqual({ revokedSessions: 2 });
      expect(repository.completePasswordReset).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        codeId: CODE_ID,
        passwordHash: 'hashed:новый-пароль-1',
      });
    });

    it('отвергает неверный код и считает попытку', async () => {
      const code = await requestCode();
      const wrong = code === '000000' ? '000001' : '000000';

      await expect(
        service.reset({ email: EMAIL, code: wrong, newPassword: 'новый-пароль-1' }),
      ).rejects.toBeInstanceOf(BusinessRuleException);

      expect(repository.registerPasswordResetAttempt).toHaveBeenCalledWith(CODE_ID, false);
      expect(repository.completePasswordReset).not.toHaveBeenCalled();
    });

    it(`гасит код на ${String(PASSWORD_RESET_MAX_ATTEMPTS)}-й неверной попытке (ТЗ 3.1)`, async () => {
      await requestCode();
      repository.findActivePasswordResetCode.mockResolvedValue(
        resetCode({
          codeHash: codes.hash('123456', ACCOUNT_ID),
          attempts: PASSWORD_RESET_MAX_ATTEMPTS - 1,
        }),
      );

      await expect(
        service.reset({ email: EMAIL, code: '654321', newPassword: 'новый-пароль-1' }),
      ).rejects.toBeInstanceOf(BusinessRuleException);

      expect(repository.registerPasswordResetAttempt).toHaveBeenCalledWith(CODE_ID, true);
    });

    it('отвергает код, если живого кода нет', async () => {
      repository.findActivePasswordResetCode.mockResolvedValue(null);

      await expect(
        service.reset({ email: EMAIL, code: '123456', newPassword: 'новый-пароль-1' }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
    });

    it('на неизвестный email отвечает тем же текстом, что и на неверный код', async () => {
      /** Текст отказа — по нему нельзя различить причину. */
      const rejection = async (dto: {
        email: string;
        code: string;
        newPassword: string;
      }): Promise<string> => {
        try {
          await service.reset(dto);
        } catch (error) {
          return (error as BusinessRuleException).message;
        }
        throw new Error('Ожидался отказ, но пароль был изменён');
      };

      const code = await requestCode();
      const wrongCode = await rejection({
        email: EMAIL,
        code: code === '000000' ? '000001' : '000000',
        newPassword: 'пароль-12',
      });

      repository.findAccountByEmail.mockResolvedValue(null);
      const unknownEmail = await rejection({
        email: 'нет-такого@example.tj',
        code: '123456',
        newPassword: 'пароль-12',
      });

      expect(unknownEmail).toBe(wrongCode);
    });

    it('не пускает заблокированный аккаунт даже с верным кодом', async () => {
      const code = await requestCode();
      repository.findAccountByEmail.mockResolvedValue(account({ status: AccountStatus.BLOCKED }));

      await expect(
        service.reset({ email: EMAIL, code, newPassword: 'новый-пароль-1' }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(repository.completePasswordReset).not.toHaveBeenCalled();
    });

    it('не принимает код, выпущенный другому аккаунту', async () => {
      const code = await requestCode();
      // Тот же код, но хеш подписан идентификатором другого аккаунта.
      repository.findActivePasswordResetCode.mockResolvedValue(
        resetCode({ codeHash: codes.hash(code, 'другой-аккаунт') }),
      );

      await expect(
        service.reset({ email: EMAIL, code, newPassword: 'новый-пароль-1' }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
    });
  });
});
