import type { AppConfigService } from '../config';
import { PASSWORD_RESET_CODE_LENGTH } from './auth.constants';
import { ResetCodeService } from './reset-code.service';

const config = (secret: string): AppConfigService =>
  ({ passwordResetSecret: secret }) as AppConfigService;

const ACCOUNT = '11111111-1111-1111-1111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-2222-2222-222222222222';

describe('ResetCodeService', () => {
  const service = new ResetCodeService(config('secret-at-least-32-characters-long!!'));

  describe('generate', () => {
    it('выдаёт ровно 6 цифр', () => {
      for (let i = 0; i < 200; i += 1) {
        expect(service.generate()).toMatch(
          new RegExp(`^\\d{${String(PASSWORD_RESET_CODE_LENGTH)}}$`),
        );
      }
    });

    it('не повторяется на коротком отрезке', () => {
      const codes = new Set(Array.from({ length: 100 }, () => service.generate()));

      // При 10^6 вариантах совпадение на сотне выпусков крайне маловероятно;
      // одинаковые коды подряд означали бы, что генератор не случаен.
      expect(codes.size).toBeGreaterThan(95);
    });
  });

  describe('hash / matches', () => {
    it('признаёт верный код', () => {
      const code = service.generate();

      expect(service.matches(code, ACCOUNT, service.hash(code, ACCOUNT))).toBe(true);
    });

    it('отвергает неверный код', () => {
      const hash = service.hash('123456', ACCOUNT);

      expect(service.matches('123457', ACCOUNT, hash)).toBe(false);
    });

    it('не принимает код, выпущенный для другого аккаунта', () => {
      const hash = service.hash('123456', ACCOUNT);

      expect(service.matches('123456', OTHER_ACCOUNT, hash)).toBe(false);
    });

    it('не хранит сам код: в хеше его не найти', () => {
      expect(service.hash('123456', ACCOUNT)).not.toContain('123456');
    });

    it('с другим секретом тот же код не подходит — перебор дампа бесполезен', () => {
      const other = new ResetCodeService(config('другой-секрет-длиной-не-менее-32-символов'));

      expect(service.matches('123456', ACCOUNT, other.hash('123456', ACCOUNT))).toBe(false);
    });

    it('не падает на испорченном значении из БД', () => {
      expect(service.matches('123456', ACCOUNT, 'не-hex')).toBe(false);
      expect(service.matches('123456', ACCOUNT, '')).toBe(false);
    });
  });
});
