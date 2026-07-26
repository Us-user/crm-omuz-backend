import { BadRequestException } from '@nestjs/common';

import type { AppConfigService } from '../config';
import { PhoneService } from './phone.service';

const configWithRegion = (region: string): AppConfigService =>
  ({ defaultPhoneRegion: region }) as AppConfigService;

describe('PhoneService', () => {
  const service = new PhoneService(configWithRegion('TJ'));

  it('приводит разные записи одного номера к одной строке E.164', () => {
    const canonical = '+992901234567';

    expect(service.normalize('+992901234567')).toBe(canonical);
    expect(service.normalize('992901234567')).toBe(canonical);
    expect(service.normalize('901234567')).toBe(canonical);
    expect(service.normalize('90 123 45 67')).toBe(canonical);
    expect(service.normalize('  +992 (90) 123-45-67  ')).toBe(canonical);
  });

  it('сохраняет номер другой страны, если он задан с кодом', () => {
    expect(service.normalize('+79161234567')).toBe('+79161234567');
  });

  it('отвергает то, что не является телефоном', () => {
    expect(() => service.normalize('12345')).toThrow(BadRequestException);
    expect(() => service.normalize('+992123')).toThrow(BadRequestException);
    expect(() => service.normalize('не телефон')).toThrow(BadRequestException);
  });

  it('называет проблемное поле в details — клиенту есть что подсветить', () => {
    expect.assertions(1);

    try {
      service.normalize('12345', 'parentPhone');
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toMatchObject({
        details: { parentPhone: expect.any(String) },
      });
    }
  });

  it('normalizeOptional пропускает пустое значение', () => {
    expect(service.normalizeOptional(undefined)).toBeUndefined();
    expect(service.normalizeOptional(null)).toBeUndefined();
    expect(service.normalizeOptional('   ')).toBeUndefined();
    expect(service.normalizeOptional('901234567')).toBe('+992901234567');
  });

  it('падает на старте, если регион по умолчанию неизвестен libphonenumber', () => {
    expect(() => new PhoneService(configWithRegion('ZZ'))).toThrow(/не поддерживается/);
  });
});
