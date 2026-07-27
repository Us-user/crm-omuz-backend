import { BadRequestException } from '@nestjs/common';

import { formatIsoMonth, parseIsoMonth } from './iso-month';

describe('parseIsoMonth', () => {
  it('разбирает месяц в его первое число (полночь UTC)', () => {
    expect(parseIsoMonth('2026-09', 'month').toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(parseIsoMonth('2026-01', 'month').toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(parseIsoMonth('2026-12', 'month').toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it.each(['2026-13', '2026-00', '2026-9', '2026', '2026-09-01', '09-2026', '', 'сентябрь'])(
    'отвергает «%s» — 400',
    (value) => {
      expect(() => parseIsoMonth(value, 'month')).toThrow(BadRequestException);
    },
  );

  it('называет поле в details, чтобы клиент подсветил вход', () => {
    try {
      parseIsoMonth('2026-13', 'from');
      fail('ожидалась ошибка');
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toMatchObject({
        details: { from: expect.stringContaining('2026-13') as string },
      });
    }
  });
});

describe('formatIsoMonth', () => {
  it('отдаёт месяц без дня: в столбце он всегда первый', () => {
    expect(formatIsoMonth(new Date('2026-09-01T00:00:00.000Z'))).toBe('2026-09');
    expect(formatIsoMonth(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01');
  });

  it('обратен разбору на всех месяцах года', () => {
    for (let month = 1; month <= 12; month += 1) {
      const value = `2026-${String(month).padStart(2, '0')}`;
      expect(formatIsoMonth(parseIsoMonth(value, 'month'))).toBe(value);
    }
  });
});
