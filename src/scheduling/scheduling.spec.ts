import { birthdaySystemKey, centerToday, previousUtcMonth } from './scheduling';

describe('scheduling (чистые функции)', () => {
  describe('centerToday', () => {
    it('сдвигает дату в пояс центра: поздний вечер по UTC — уже следующий день', () => {
      // 2026-08-02 21:00 UTC = 2026-08-03 02:00 в UTC+5.
      const now = new Date('2026-08-02T21:00:00.000Z');

      expect(centerToday(now, 300)).toEqual({ year: 2026, month: 8, day: 3 });
    });

    it('без смещения совпадает с UTC-датой', () => {
      const now = new Date('2026-08-03T10:00:00.000Z');

      expect(centerToday(now, 0)).toEqual({ year: 2026, month: 8, day: 3 });
    });

    it('переносит через границу месяца', () => {
      // 2026-07-31 20:00 UTC = 2026-08-01 01:00 в UTC+5.
      const now = new Date('2026-07-31T20:00:00.000Z');

      expect(centerToday(now, 300)).toEqual({ year: 2026, month: 8, day: 1 });
    });

    it('переносит через границу года', () => {
      // 2026-12-31 20:00 UTC = 2027-01-01 01:00 в UTC+5.
      const now = new Date('2026-12-31T20:00:00.000Z');

      expect(centerToday(now, 300)).toEqual({ year: 2027, month: 1, day: 1 });
    });
  });

  describe('birthdaySystemKey', () => {
    it('собирает ключ с ведущими нулями', () => {
      expect(birthdaySystemKey({ year: 2026, month: 8, day: 3 })).toBe('birthday:2026-08-03');
      expect(birthdaySystemKey({ year: 2026, month: 12, day: 25 })).toBe('birthday:2026-12-25');
    });
  });

  describe('previousUtcMonth', () => {
    it('отдаёт прошлый месяц в UTC', () => {
      expect(previousUtcMonth(new Date('2026-08-01T05:00:00.000Z'))).toBe('2026-07');
    });

    it('перешагивает через границу года', () => {
      expect(previousUtcMonth(new Date('2026-01-01T05:00:00.000Z'))).toBe('2025-12');
    });

    it('пояс центра не учитывается — месяц считается в UTC', () => {
      // Первое число, но ещё до полуночи по UTC-контексту: месяц всё равно UTC.
      expect(previousUtcMonth(new Date('2026-03-01T00:30:00.000Z'))).toBe('2026-02');
    });
  });
});
