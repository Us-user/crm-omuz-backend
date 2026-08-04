import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { AccountStatus, Locale } from '@prisma/client';

import { parseIsoDate } from '../common';
import { PhoneService } from '../phone';
import { LOGIN_RATE_LIMIT, RateLimitService, subjectRateLimitKey } from '../rate-limit';
import { TOKEN_TYPE } from './auth.constants';
import type { AccountWithProfile } from './auth.repository';
import { AuthRepository } from './auth.repository';
import type { AuthenticatedUser, RequestContext, TokenPair } from './auth.types';
import type { LoginDto, RefreshTokenDto, RegisterDto } from './dto';
import { AuthResponseDto, LogoutResponseDto } from './dto';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/** Один текст на «нет такого телефона» и «неверный пароль»: иначе форма входа превращается в проверку, кто зарегистрирован. */
const INVALID_CREDENTIALS = 'Неверный номер телефона или пароль';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly repository: AuthRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly phones: PhoneService,
    /**
     * Нужен ровно для одного: обнулить счётчик попыток входа после успешного.
     * `@Optional()` — по доводу `MessageSender` в журнале групп (0037): наборам,
     * которым лимиты не нужны, незачем тянуть Redis, а вход без лимитера
     * работает ровно так же, просто счётчик доживает своё окно сам.
     */
    @Optional() private readonly rateLimit?: RateLimitService,
  ) {}

  /** Самостоятельная регистрация студента (ТЗ 3.1, 5.1). */
  async register(dto: RegisterDto, context: RequestContext): Promise<AuthResponseDto> {
    const phone = this.phones.normalize(dto.phone, 'phone');
    const parentPhone = this.phones.normalizeOptional(dto.parentPhone, 'parentPhone');
    const birthDate = parseBirthDate(dto.birthDate);

    const taken = await this.repository.findAccountByPhoneOrEmail(phone, dto.email);
    if (taken) {
      throw new ConflictException(
        taken.phone === phone ? 'Номер телефона уже зарегистрирован' : 'Email уже зарегистрирован',
      );
    }

    // Профиль студента мог быть заведён администратором раньше аккаунта
    // (ТЗ 5.3: «аккаунт опционален, Invite») — тогда это не регистрация, а приглашение.
    const existingProfile = await this.repository.findStudentByPhone(phone);
    if (existingProfile) {
      throw new ConflictException(
        'Студент с таким номером уже заведён в системе — войдите по приглашению администратора',
      );
    }

    const account = await this.repository.createStudentAccount({
      phone,
      email: dto.email,
      passwordHash: await this.passwords.hash(dto.password),
      locale: dto.locale ?? Locale.RU,
      firstName: dto.firstName,
      lastName: dto.lastName,
      birthDate,
      address: dto.address,
      parentPhone,
    });

    return this.startSession(account, context);
  }

  /** Вход по номеру телефона и паролю (ТЗ 5.1). */
  async login(dto: LoginDto, context: RequestContext): Promise<AuthResponseDto> {
    const phone = this.phones.normalize(dto.phone, 'phone');
    const account = await this.repository.findAccountByPhone(phone);

    if (!account) {
      // Тратим столько же времени, сколько на реальную проверку хеша.
      await this.passwords.verifyDummy(dto.password);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const passwordMatches = await this.passwords.verify(account.passwordHash, dto.password);
    if (!passwordMatches) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    // Проверяем блокировку только после пароля: иначе чужой номер можно
    // «прощупать» и узнать, что аккаунт существует и заблокирован (ТЗ 5.3).
    if (account.status === AccountStatus.BLOCKED) {
      throw new ForbiddenException('Аккаунт заблокирован. Обратитесь к администратору');
    }

    await this.repository.touchLastLogin(account.id);
    await this.forgetFailedAttempts(phone);

    return this.startSession(account, context);
  }

  /**
   * Обнуляет счётчик попыток входа по номеру (ТЗ 3.8). Без этого лимит
   * работал бы против того, кого защищает: человек, вспомнивший пароль после
   * пары опечаток, доживал бы окно с почти исчерпанным лимитом, а чужой
   * перебор его номера закрывал бы ему вход насовсем.
   *
   * Ключ собирается **из нормализованного** номера — тем же выражением, что
   * в guard'е: иначе счётчик заводился бы на один ключ, а гасился на другой.
   *
   * Сбой лимитера вход не роняет: он уже состоялся (приём отчёта Директору, 0037).
   */
  private async forgetFailedAttempts(phone: string): Promise<void> {
    if (!this.rateLimit) return;

    try {
      await this.rateLimit.reset(subjectRateLimitKey(LOGIN_RATE_LIMIT.action, phone));
    } catch (error: unknown) {
      this.logger.warn(
        `Не удалось обнулить счётчик попыток входа: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Обмен refresh-токена на новую пару с ротацией (ТЗ 3.1):
   * старый токен становится недействительным сразу после выдачи нового.
   */
  async refresh(dto: RefreshTokenDto, context: RequestContext): Promise<AuthResponseDto> {
    const payload = await this.tokens.verifyRefresh(dto.refreshToken);
    const session = await this.repository.findSessionById(payload.sid);

    if (!session || session.accountId !== payload.sub) {
      throw new UnauthorizedException('Сессия не найдена');
    }

    if (session.revokedAt !== null) {
      throw new UnauthorizedException('Сессия завершена, войдите заново');
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Срок сессии истёк, войдите заново');
    }

    if (!this.tokens.matchesFingerprint(dto.refreshToken, session.refreshTokenHash)) {
      // Подпись валидна, но токен уже заменён при ротации: скорее всего им
      // воспользовался кто-то ещё. Гасим сессию целиком.
      await this.repository.revokeSession(session.id);
      this.logger.warn(
        `Повторное использование refresh-токена: сессия ${session.id} (аккаунт ${session.accountId}) отозвана`,
      );
      throw new UnauthorizedException('Сессия завершена, войдите заново');
    }

    const account = await this.repository.findAccountById(session.accountId);
    if (!account) {
      throw new UnauthorizedException('Аккаунт не найден');
    }
    if (account.status === AccountStatus.BLOCKED) {
      throw new ForbiddenException('Аккаунт заблокирован. Обратитесь к администратору');
    }

    const pair = await this.tokens.issuePair({
      sub: account.id,
      sid: session.id,
      type: account.type,
    });

    await this.repository.rotateSession(session.id, {
      refreshTokenHash: this.tokens.fingerprint(pair.refreshToken),
      expiresAt: pair.refreshExpiresAt,
      userAgent: context.userAgent,
      ip: context.ip,
    });

    return toAuthResponse(account, pair);
  }

  /** Выход с текущего устройства: гасится сессия из access-токена. */
  async logout(user: AuthenticatedUser): Promise<LogoutResponseDto> {
    const revoked = await this.repository.revokeSession(user.sessionId);
    return { revokedSessions: revoked ? 1 : 0 };
  }

  /** Выход со всех устройств (ТЗ 3.1). */
  async logoutAll(user: AuthenticatedUser): Promise<LogoutResponseDto> {
    const revokedSessions = await this.repository.revokeAllSessions(user.accountId);
    return { revokedSessions };
  }

  /**
   * Заводит серверную сессию и выдаёт пару токенов. Идентификатор сессии
   * генерируется заранее: он должен попасть в токен ещё до записи строки.
   */
  private async startSession(
    account: AccountWithProfile,
    context: RequestContext,
  ): Promise<AuthResponseDto> {
    const sessionId = randomUUID();

    const pair = await this.tokens.issuePair({
      sub: account.id,
      sid: sessionId,
      type: account.type,
    });

    await this.repository.createSession({
      id: sessionId,
      accountId: account.id,
      refreshTokenHash: this.tokens.fingerprint(pair.refreshToken),
      expiresAt: pair.refreshExpiresAt,
      userAgent: context.userAgent,
      ip: context.ip,
    });

    return toAuthResponse(account, pair);
  }
}

/**
 * Разбирает дату рождения из `YYYY-MM-DD`. Формат уже проверен DTO, разбор
 * и несуществующие даты — в `parseIsoDate`; здесь добавляется запрет будущего.
 */
function parseBirthDate(value: string): Date {
  const date = parseIsoDate(value, 'birthDate', 'Некорректная дата рождения');

  if (date.getTime() > Date.now()) {
    throw new BadRequestException({
      message: 'Некорректная дата рождения',
      details: { birthDate: 'Дата рождения не может быть в будущем' },
    });
  }

  return date;
}

function toAuthResponse(account: AccountWithProfile, pair: TokenPair): AuthResponseDto {
  const profile = account.student ?? account.employee ?? null;

  return {
    account: {
      id: account.id,
      phone: account.phone,
      email: account.email,
      type: account.type,
      status: account.status,
      locale: account.locale,
      profile,
    },
    tokens: {
      tokenType: TOKEN_TYPE,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      expiresIn: pair.expiresIn,
    },
  };
}
