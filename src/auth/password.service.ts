import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Параметры argon2id (ТЗ 3.1). Значения — рекомендация OWASP с запасом:
 * 64 МиБ памяти, 3 прохода, параллелизм 4.
 */
const OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
};

@Injectable()
export class PasswordService {
  /**
   * Хеш случайной строки, посчитанный один раз. Нужен, чтобы вход с
   * незарегистрированным телефоном занимал столько же времени, сколько реальная
   * проверка пароля: иначе по времени ответа перебором вычисляются
   * зарегистрированные номера.
   */
  private dummyHash?: Promise<string>;

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, OPTIONS);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      // Битый или чужой формат хеша — это «не совпало», а не 500.
      return false;
    }
  }

  /** Холостая проверка для выравнивания времени ответа. Результат не используется. */
  async verifyDummy(plain: string): Promise<void> {
    this.dummyHash ??= this.hash(randomBytes(32).toString('hex'));
    await this.verify(await this.dummyHash, plain);
  }
}
