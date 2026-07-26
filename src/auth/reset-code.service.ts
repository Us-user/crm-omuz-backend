import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { AppConfigService } from '../config';
import { PASSWORD_RESET_CODE_LENGTH } from './auth.constants';

/** 10^6 для шестизначного кода — верхняя граница диапазона генерации. */
const CODE_SPACE = 10 ** PASSWORD_RESET_CODE_LENGTH;

/**
 * Выпуск и проверка одноразовых кодов сброса пароля (ТЗ 3.1).
 *
 * Код хранится как **HMAC-SHA256 с серверным секретом**, а не как argon2-хеш
 * пароля. Причина в том, что код короткий (10^6 вариантов):
 * - обычный быстрый хеш (SHA-256) из утёкшей таблицы обращается перебором мгновенно;
 * - медленный argon2 от этого защищает, но даёт вектор DoS — каждый запрос
 *   `password/forgot` стоил бы 64 МиБ и ~100 мс процессорного времени, и это на
 *   публичном эндпоинте;
 * - HMAC с секретом, которого нет в БД, делает перебор дампа бессмысленным и
 *   при этом стоит микросекунды. Онлайн-перебор ограничен счётчиком попыток,
 *   поэтому медленная функция здесь ничего не добавляет.
 *
 * Идентификатор аккаунта входит в подпись: хеш, взятый из строки одного
 * аккаунта, не подойдёт другому.
 */
@Injectable()
export class ResetCodeService {
  constructor(private readonly config: AppConfigService) {}

  /**
   * Криптостойкий код из `PASSWORD_RESET_CODE_LENGTH` цифр.
   * `randomInt` берёт значения равномерно, без смещения, которое даёт `% 10^6`.
   */
  generate(): string {
    return String(randomInt(0, CODE_SPACE)).padStart(PASSWORD_RESET_CODE_LENGTH, '0');
  }

  hash(code: string, accountId: string): string {
    return createHmac('sha256', this.config.passwordResetSecret)
      .update(`${accountId}:${code}`)
      .digest('hex');
  }

  /** Сравнение за постоянное время: по времени ответа код не подбирается посимвольно. */
  matches(code: string, accountId: string, storedHash: string): boolean {
    const actual = Buffer.from(this.hash(code, accountId), 'hex');
    const expected = Buffer.from(storedHash, 'hex');

    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }
}
