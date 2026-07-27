import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { AccountStatus } from '@prisma/client';

import { BusinessRuleException } from '../common';
import { MailerService } from '../mailer';
import {
  PASSWORD_RESET_MAX_ATTEMPTS,
  PASSWORD_RESET_MAX_REQUESTS_PER_HOUR,
  PASSWORD_RESET_RATE_WINDOW_SECONDS,
  PASSWORD_RESET_TTL_SECONDS,
} from './auth.constants';
import { AuthRepository } from './auth.repository';
import type { ForgotPasswordDto, ResetPasswordDto } from './dto';
import { ForgotPasswordResponseDto, ResetPasswordResponseDto } from './dto';
import { PasswordService } from './password.service';
import { renderPasswordResetEmail } from './password-reset.templates';
import { ResetCodeService } from './reset-code.service';

/**
 * Ответ на `forgot` не зависит от того, нашёлся аккаунт или нет: иначе форма
 * восстановления становится проверкой «есть ли такой email в системе».
 */
const FORGOT_ACCEPTED =
  'Если аккаунт с таким email существует, на него отправлен код восстановления';

/**
 * Один текст на «кода нет», «код не тот» и «попытки исчерпаны»: любое различие
 * подсказывает перебирающему, в каком направлении двигаться.
 */
const INVALID_CODE = 'Код неверен или истёк. Запросите новый код';

/**
 * Сброс пароля по email (ТЗ 3.1, 5.1): 6-значный код, ~10 минут,
 * не более 3 запросов в час и 3 попыток ввода.
 *
 * Вынесен из `AuthService`: у сценария своё хранилище (коды), свой канал
 * доставки (почта) и свои лимиты — в сервисе входа ему тесно.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly repository: AuthRepository,
    private readonly passwords: PasswordService,
    private readonly codes: ResetCodeService,
    private readonly mailer: MailerService,
  ) {}

  /** Запрос кода восстановления (`POST /auth/password/forgot`). */
  async forgot(dto: ForgotPasswordDto): Promise<ForgotPasswordResponseDto> {
    const account = await this.repository.findAccountByEmail(dto.email);

    // Заблокированному аккаунту код не отправляем: сброс пароля не должен
    // становиться обходным путём вокруг блокировки (ТЗ 5.3).
    if (!account || account.status === AccountStatus.BLOCKED) {
      return { message: FORGOT_ACCEPTED };
    }

    if (await this.rateLimited(account.id)) {
      // Наружу — тот же ответ: 429 выдал бы, что аккаунт существует.
      this.logger.warn(
        `Превышен лимит запросов кода сброса пароля (${String(PASSWORD_RESET_MAX_REQUESTS_PER_HOUR)}/час): аккаунт ${account.id}`,
      );
      return { message: FORGOT_ACCEPTED };
    }

    const code = await this.issueCode(account.id);

    await this.mailer.send(
      renderPasswordResetEmail({
        to: account.email,
        locale: account.locale,
        code,
        ttlSeconds: PASSWORD_RESET_TTL_SECONDS,
      }),
    );

    return { message: FORGOT_ACCEPTED };
  }

  /**
   * Выпускает одноразовый код и гасит прежние: живым остаётся ровно один,
   * иначе «свежий» код не отменял бы отправленный минуту назад.
   *
   * Письмо отправляет вызывающий — у приглашения студента (ТЗ 5.3) свой текст,
   * а жизненный цикл кода (подпись, срок, единственность) должен остаться
   * в одном месте. Установка пароля по такому коду идёт общим путём
   * `POST /auth/password/reset`.
   *
   * Лимита «3 в час» здесь нет намеренно: он относится к **публичному** запросу
   * кода (ТЗ 3.1) и проверяется в `forgot`, до вызова.
   *
   * @returns код открытым текстом — единственное место, где он существует.
   */
  async issueCode(accountId: string): Promise<string> {
    const code = this.codes.generate();

    await this.repository.consumeActivePasswordResetCodes(accountId);
    await this.repository.createPasswordResetCode({
      accountId,
      codeHash: this.codes.hash(code, accountId),
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000),
    });

    return code;
  }

  /** Установка нового пароля по коду (`POST /auth/password/reset`). */
  async reset(dto: ResetPasswordDto): Promise<ResetPasswordResponseDto> {
    const account = await this.repository.findAccountByEmail(dto.email);
    if (!account) {
      throw new BusinessRuleException(INVALID_CODE);
    }

    const active = await this.repository.findActivePasswordResetCode(account.id, new Date());
    if (!active) {
      throw new BusinessRuleException(INVALID_CODE);
    }

    if (!this.codes.matches(dto.code, account.id, active.codeHash)) {
      // На исчерпании лимита гасим код: иначе оставшиеся до истечения минуты
      // можно было бы перебирать бесконечно, запрашивая ошибку за ошибкой.
      const exhausted = active.attempts + 1 >= PASSWORD_RESET_MAX_ATTEMPTS;
      await this.repository.registerPasswordResetAttempt(active.id, exhausted);

      if (exhausted) {
        this.logger.warn(
          `Код сброса пароля погашен после ${String(PASSWORD_RESET_MAX_ATTEMPTS)} неверных попыток: аккаунт ${account.id}`,
        );
      }

      throw new BusinessRuleException(INVALID_CODE);
    }

    // Владение почтой доказано — про блокировку можно сказать прямо.
    if (account.status === AccountStatus.BLOCKED) {
      throw new ForbiddenException('Аккаунт заблокирован. Обратитесь к администратору');
    }

    const revokedSessions = await this.repository.completePasswordReset({
      accountId: account.id,
      codeId: active.id,
      passwordHash: await this.passwords.hash(dto.newPassword),
    });

    this.logger.log(
      `Пароль сброшен по коду: аккаунт ${account.id}, погашено сессий: ${String(revokedSessions)}`,
    );

    return { revokedSessions };
  }

  /** ТЗ 3.1: не более `PASSWORD_RESET_MAX_REQUESTS_PER_HOUR` запросов кода в час. */
  private async rateLimited(accountId: string): Promise<boolean> {
    const since = new Date(Date.now() - PASSWORD_RESET_RATE_WINDOW_SECONDS * 1000);
    const recent = await this.repository.countPasswordResetCodesSince(accountId, since);

    return recent >= PASSWORD_RESET_MAX_REQUESTS_PER_HOUR;
  }
}
