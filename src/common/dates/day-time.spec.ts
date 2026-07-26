import { BadRequestException } from '@nestjs/common';

import { formatDayTime, parseDayTime } from './day-time';

describe('parseDayTime', () => {
  it('переводит время в минуты от полуночи', () => {
    expect(parseDayTime('00:00', 'startTime')).toBe(0);
    expect(parseDayTime('10:00', 'startTime')).toBe(600);
    expect(parseDayTime('10:30', 'startTime')).toBe(630);
    expect(parseDayTime('23:59', 'endTime')).toBe(1439);
  });

  it.each(['24:00', '10:60', '9:00', '10:5', '1000', '10.00', '', 'полдень'])(
    'отвергает «%s» — 400',
    (value) => {
      expect(() => parseDayTime(value, 'startTime')).toThrow(BadRequestException);
    },
  );

  it('называет поле в details, чтобы клиент подсветил вход', () => {
    try {
      parseDayTime('25:00', 'endTime');
      fail('ожидалась ошибка');
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toMatchObject({
        details: { endTime: expect.stringContaining('25:00') as string },
      });
    }
  });
});

describe('formatDayTime', () => {
  it('возвращает время с ведущими нулями', () => {
    expect(formatDayTime(0)).toBe('00:00');
    expect(formatDayTime(65)).toBe('01:05');
    expect(formatDayTime(600)).toBe('10:00');
    expect(formatDayTime(1439)).toBe('23:59');
  });

  it('обратен разбору на всех минутах суток', () => {
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      expect(parseDayTime(formatDayTime(minute), 'time')).toBe(minute);
    }
  });
});
