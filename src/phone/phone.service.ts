import { BadRequestException, Injectable } from '@nestjs/common';
import type { CountryCode } from 'libphonenumber-js';
import { isSupportedCountry, parsePhoneNumberFromString } from 'libphonenumber-js';

import { AppConfigService } from '../config';

/**
 * Приведение телефонов к E.164 (ТЗ 3.1). Один номер должен давать одну строку
 * в БД независимо от того, как его ввели: `+992 90 123-45-67`, `992901234567`
 * или локальное `901234567`.
 *
 * Вынесено из Auth: те же правила нужны студентам, сотрудникам и лидам.
 */
@Injectable()
export class PhoneService {
  private readonly defaultRegion: CountryCode;

  constructor(config: AppConfigService) {
    const region = config.defaultPhoneRegion.toUpperCase();
    // Схема окружения уже проверила формат ISO 3166-1 alpha-2; здесь убеждаемся,
    // что libphonenumber знает про такой регион, иначе разбор молча деградирует.
    if (!isSupportedCountry(region)) {
      throw new Error(`DEFAULT_PHONE_REGION: регион «${region}» не поддерживается`);
    }
    this.defaultRegion = region;
  }

  /**
   * Нормализует номер в E.164 (`+992901234567`).
   *
   * @param field имя поля — попадает в `details` ошибки, чтобы клиент подсветил вход.
   * @throws BadRequestException если номер не является валидным (400 VALIDATION_ERROR).
   */
  normalize(input: string, field = 'phone'): string {
    const parsed = parsePhoneNumberFromString(input.trim(), this.defaultRegion);

    if (!parsed?.isValid()) {
      throw new BadRequestException({
        message: 'Некорректный номер телефона',
        details: { [field]: `Не удалось разобрать номер «${input}» как телефонный` },
      });
    }

    return parsed.number;
  }

  /** Как `normalize`, но пустое/отсутствующее значение пропускает без ошибки. */
  normalizeOptional(input: string | undefined | null, field = 'phone'): string | undefined {
    if (input === undefined || input === null || input.trim() === '') return undefined;
    return this.normalize(input, field);
  }
}
