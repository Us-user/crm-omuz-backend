import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AccountStatus, AccountType, Locale } from '@prisma/client';
import type { Session } from '@prisma/client';

import type { AppConfigService } from '../config';
import { PhoneService } from '../phone';
import type { AccountWithProfile, AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import type { AuthenticatedUser, RequestContext } from './auth.types';
import type { RegisterDto } from './dto';
import type { PasswordService } from './password.service';
import { TokenService } from './token.service';

const CONTEXT: RequestContext = { userAgent: 'jest', ip: '127.0.0.1' };

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const SESSION_ID = '22222222-2222-2222-2222-222222222222';

const REGISTER_DTO: RegisterDto = {
  firstName: 'Фаррух',
  lastName: 'Раҳимов',
  birthDate: '2004-05-12',
  address: 'г. Душанбе, ул. Рудаки, 25',
  email: 'farrukh@example.tj',
  // Локальная запись: сервис обязан привести её к E.164.
  phone: '901234567',
  parentPhone: '907654321',
  password: 'очень-секретный-пароль',
};

const account = (overrides: Partial<AccountWithProfile> = {}): AccountWithProfile => ({
  id: ACCOUNT_ID,
  phone: '+992901234567',
  email: 'farrukh@example.tj',
  passwordHash: 'hashed:очень-секретный-пароль',
  type: AccountType.STUDENT,
  status: AccountStatus.ACTIVE,
  locale: Locale.RU,
  student: { id: 'student-1', firstName: 'Фаррух', lastName: 'Раҳимов' },
  employee: null,
  ...overrides,
});

const session = (overrides: Partial<Session> = {}): Session => ({
  id: SESSION_ID,
  accountId: ACCOUNT_ID,
  refreshTokenHash: 'заменяется в тестах',
  userAgent: 'jest',
  ip: '127.0.0.1',
  expiresAt: new Date(Date.now() + 60_000),
  revokedAt: null,
  lastUsedAt: new Date(),
  createdAt: new Date(),
  ...overrides,
});

describe('AuthService', () => {
  let repository: jest.Mocked<AuthRepository>;
  let passwords: jest.Mocked<PasswordService>;
  let tokens: TokenService;
  let service: AuthService;

  beforeEach(() => {
    repository = {
      findAccountByPhone: jest.fn(),
      findAccountById: jest.fn(),
      findAccountByPhoneOrEmail: jest.fn().mockResolvedValue(null),
      findStudentByPhone: jest.fn().mockResolvedValue(null),
      createStudentAccount: jest.fn().mockResolvedValue(account()),
      touchLastLogin: jest.fn().mockResolvedValue(undefined),
      createSession: jest.fn().mockResolvedValue(session()),
      findSessionById: jest.fn(),
      rotateSession: jest.fn().mockResolvedValue(undefined),
      revokeSession: jest.fn().mockResolvedValue(true),
      revokeAllSessions: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<AuthRepository>;

    // Подменяем argon2 быстрым эквивалентом: сам алгоритм проверяется в password.service.spec.
    passwords = {
      hash: jest.fn((plain: string) => Promise.resolve(`hashed:${plain}`)),
      verify: jest.fn((hash: string, plain: string) => Promise.resolve(hash === `hashed:${plain}`)),
      verifyDummy: jest.fn(() => Promise.resolve()),
    } as unknown as jest.Mocked<PasswordService>;

    // Токены и телефоны — настоящие: их логика и есть предмет проверки.
    tokens = new TokenService(new JwtService({}), {
      jwt: {
        accessSecret: 'access-secret-at-least-32-characters-long',
        refreshSecret: 'refresh-secret-at-least-32-characters-long',
        accessTtlSeconds: 3600,
        refreshTtlSeconds: 1_209_600,
      },
    } as AppConfigService);

    const phones = new PhoneService({ defaultPhoneRegion: 'TJ' } as AppConfigService);

    service = new AuthService(repository, passwords, tokens, phones);
  });

  describe('register', () => {
    it('создаёт аккаунт студента с телефоном в E.164 и argon2id-хешем', async () => {
      const result = await service.register(REGISTER_DTO, CONTEXT);

      expect(repository.createStudentAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          phone: '+992901234567',
          parentPhone: '+992907654321',
          email: 'farrukh@example.tj',
          passwordHash: 'hashed:очень-секретный-пароль',
          birthDate: new Date('2004-05-12T00:00:00.000Z'),
          locale: Locale.RU,
        }),
      );

      expect(result.tokens.tokenType).toBe('Bearer');
      expect(result.tokens.expiresIn).toBe(3600);
      expect(result.account.phone).toBe('+992901234567');
      expect(result.account.profile).toEqual({
        id: 'student-1',
        firstName: 'Фаррух',
        lastName: 'Раҳимов',
      });
    });

    it('заводит серверную сессию с отпечатком выданного refresh-токена', async () => {
      const result = await service.register(REGISTER_DTO, CONTEXT);

      const created = repository.createSession.mock.calls[0][0];
      expect(created.refreshTokenHash).toBe(tokens.fingerprint(result.tokens.refreshToken));
      expect(created.refreshTokenHash).not.toContain(result.tokens.refreshToken);
      expect(created.userAgent).toBe('jest');
      expect(created.ip).toBe('127.0.0.1');
    });

    it('не отдаёт наружу хеш пароля', async () => {
      const result = await service.register(REGISTER_DTO, CONTEXT);

      expect(JSON.stringify(result)).not.toContain('hashed:');
    });

    it('отвечает 409, если телефон или email уже заняты', async () => {
      repository.findAccountByPhoneOrEmail.mockResolvedValue({
        phone: '+992901234567',
        email: 'другой@example.tj',
      });
      await expect(service.register(REGISTER_DTO, CONTEXT)).rejects.toThrow(
        /Номер телефона уже зарегистрирован/,
      );

      repository.findAccountByPhoneOrEmail.mockResolvedValue({
        phone: '+992999999999',
        email: 'farrukh@example.tj',
      });
      await expect(service.register(REGISTER_DTO, CONTEXT)).rejects.toThrow(
        /Email уже зарегистрирован/,
      );
    });

    it('отвечает 409, если профиль студента уже заведён администратором', async () => {
      repository.findStudentByPhone.mockResolvedValue({ id: 'student-1' });

      await expect(service.register(REGISTER_DTO, CONTEXT)).rejects.toThrow(ConflictException);
      expect(repository.createStudentAccount).not.toHaveBeenCalled();
    });

    it('отвергает несуществующую дату рождения и дату из будущего', async () => {
      await expect(
        service.register({ ...REGISTER_DTO, birthDate: '2004-02-30' }, CONTEXT),
      ).rejects.toThrow(BadRequestException);

      const future = await service
        .register({ ...REGISTER_DTO, birthDate: '2999-01-01' }, CONTEXT)
        .catch((error: BadRequestException) => error.getResponse());
      expect(future).toMatchObject({ details: { birthDate: /не может быть в будущем/ } });

      expect(repository.createStudentAccount).not.toHaveBeenCalled();
    });

    it('отвергает номер, который не является телефоном', async () => {
      await expect(service.register({ ...REGISTER_DTO, phone: '12345' }, CONTEXT)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('login', () => {
    it('пускает по нормализованному телефону и отмечает время входа', async () => {
      repository.findAccountByPhone.mockResolvedValue(account());

      const result = await service.login(
        { phone: '90 123 45 67', password: 'очень-секретный-пароль' },
        CONTEXT,
      );

      expect(repository.findAccountByPhone).toHaveBeenCalledWith('+992901234567');
      expect(repository.touchLastLogin).toHaveBeenCalledWith(ACCOUNT_ID);
      expect(result.tokens.accessToken).toEqual(expect.any(String));
    });

    it('на неизвестный телефон отвечает 401 и всё равно считает хеш — иначе номера перебираются по времени ответа', async () => {
      repository.findAccountByPhone.mockResolvedValue(null);

      await expect(
        service.login({ phone: '+992901234567', password: 'любой' }, CONTEXT),
      ).rejects.toThrow(UnauthorizedException);

      expect(passwords.verifyDummy).toHaveBeenCalledWith('любой');
      expect(repository.createSession).not.toHaveBeenCalled();
    });

    it('на неизвестный телефон и на неверный пароль отвечает одинаково', async () => {
      repository.findAccountByPhone.mockResolvedValueOnce(null);
      const unknownPhone = await service
        .login({ phone: '+992901234567', password: 'любой' }, CONTEXT)
        .catch((error: Error) => error.message);

      repository.findAccountByPhone.mockResolvedValueOnce(account());
      const wrongPassword = await service
        .login({ phone: '+992901234567', password: 'неверный' }, CONTEXT)
        .catch((error: Error) => error.message);

      expect(unknownPhone).toBe(wrongPassword);
    });

    it('заблокированному аккаунту отвечает 403 (ТЗ 5.3)', async () => {
      repository.findAccountByPhone.mockResolvedValue(account({ status: AccountStatus.BLOCKED }));

      await expect(
        service.login({ phone: '+992901234567', password: 'очень-секретный-пароль' }, CONTEXT),
      ).rejects.toThrow(ForbiddenException);
    });

    it('о блокировке сообщает только после верного пароля — иначе это утечка о чужом аккаунте', async () => {
      repository.findAccountByPhone.mockResolvedValue(account({ status: AccountStatus.BLOCKED }));

      await expect(
        service.login({ phone: '+992901234567', password: 'неверный' }, CONTEXT),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('refresh', () => {
    /** Выдаёт валидную пару и кладёт её отпечаток в сессию — исходное состояние для проверок. */
    const issueLiveSession = async (overrides: Partial<Session> = {}) => {
      const pair = await tokens.issuePair({
        sub: ACCOUNT_ID,
        sid: SESSION_ID,
        type: AccountType.STUDENT,
      });

      repository.findSessionById.mockResolvedValue(
        session({ refreshTokenHash: tokens.fingerprint(pair.refreshToken), ...overrides }),
      );
      repository.findAccountById.mockResolvedValue(account());

      return pair;
    };

    it('выдаёт новую пару и заменяет отпечаток в сессии (ротация, ТЗ 3.1)', async () => {
      const pair = await issueLiveSession();

      const result = await service.refresh({ refreshToken: pair.refreshToken }, CONTEXT);

      expect(result.tokens.refreshToken).not.toBe(pair.refreshToken);
      expect(repository.rotateSession).toHaveBeenCalledWith(
        SESSION_ID,
        expect.objectContaining({
          refreshTokenHash: tokens.fingerprint(result.tokens.refreshToken),
        }),
      );
    });

    it('отвергает refresh, подписанный чужим секретом', async () => {
      await expect(service.refresh({ refreshToken: 'не.токен.вовсе' }, CONTEXT)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(repository.rotateSession).not.toHaveBeenCalled();
    });

    it('отвергает отозванную и истёкшую сессию', async () => {
      const revoked = await issueLiveSession({ revokedAt: new Date() });
      await expect(
        service.refresh({ refreshToken: revoked.refreshToken }, CONTEXT),
      ).rejects.toThrow(/Сессия завершена/);

      const expired = await issueLiveSession({ expiresAt: new Date(Date.now() - 1000) });
      await expect(
        service.refresh({ refreshToken: expired.refreshToken }, CONTEXT),
      ).rejects.toThrow(/Срок сессии истёк/);
    });

    it('отвергает токен, чья сессия не найдена', async () => {
      const pair = await issueLiveSession();
      repository.findSessionById.mockResolvedValue(null);

      await expect(service.refresh({ refreshToken: pair.refreshToken }, CONTEXT)).rejects.toThrow(
        /Сессия не найдена/,
      );
    });

    it('при повторном использовании старого токена гасит сессию целиком', async () => {
      const old = await issueLiveSession();
      // Ротация уже произошла: в сессии лежит отпечаток другого токена.
      repository.findSessionById.mockResolvedValue(session({ refreshTokenHash: 'a'.repeat(64) }));

      await expect(service.refresh({ refreshToken: old.refreshToken }, CONTEXT)).rejects.toThrow(
        UnauthorizedException,
      );

      expect(repository.revokeSession).toHaveBeenCalledWith(SESSION_ID);
      expect(repository.rotateSession).not.toHaveBeenCalled();
    });

    it('не обновляет токены заблокированному аккаунту', async () => {
      const pair = await issueLiveSession();
      repository.findAccountById.mockResolvedValue(account({ status: AccountStatus.BLOCKED }));

      await expect(service.refresh({ refreshToken: pair.refreshToken }, CONTEXT)).rejects.toThrow(
        ForbiddenException,
      );
      expect(repository.rotateSession).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    const user: AuthenticatedUser = {
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      type: AccountType.STUDENT,
    };

    it('гасит текущую сессию', async () => {
      await expect(service.logout(user)).resolves.toEqual({ revokedSessions: 1 });
      expect(repository.revokeSession).toHaveBeenCalledWith(SESSION_ID);
    });

    it('на уже завершённой сессии не считает её повторно', async () => {
      repository.revokeSession.mockResolvedValue(false);

      await expect(service.logout(user)).resolves.toEqual({ revokedSessions: 0 });
    });

    it('logout-all гасит все сессии аккаунта и возвращает их число', async () => {
      repository.revokeAllSessions.mockResolvedValue(3);

      await expect(service.logoutAll(user)).resolves.toEqual({ revokedSessions: 3 });
      expect(repository.revokeAllSessions).toHaveBeenCalledWith(ACCOUNT_ID);
    });
  });

  it('на каждый вход заводит отдельную сессию — «выйти с одного устройства» не трогает остальные', async () => {
    repository.findAccountByPhone.mockResolvedValue(account());

    await service.login({ phone: '+992901234567', password: 'очень-секретный-пароль' }, CONTEXT);
    await service.login({ phone: '+992901234567', password: 'очень-секретный-пароль' }, CONTEXT);

    const [first, second] = repository.createSession.mock.calls.map(([input]) => input.id);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(randomUUID()).not.toBe(first);
  });
});
