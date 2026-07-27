import { coinsForWeekSum, COIN_AWARD_THRESHOLDS } from './coin-award';

describe('coinsForWeekSum (ТЗ 5.9)', () => {
  it('даёт 5 коинов за итог 100 и выше', () => {
    expect(coinsForWeekSum(100)).toBe(5);
    expect(coinsForWeekSum(137)).toBe(5);
  });

  it('даёт 4 коина за 90–99', () => {
    expect(coinsForWeekSum(90)).toBe(4);
    expect(coinsForWeekSum(99)).toBe(4);
  });

  it('даёт 2 коина за 85–89', () => {
    expect(coinsForWeekSum(85)).toBe(2);
    expect(coinsForWeekSum(89)).toBe(2);
  });

  it('ниже 85 не даёт ничего', () => {
    expect(coinsForWeekSum(84)).toBe(0);
    expect(coinsForWeekSum(0)).toBe(0);
  });

  it('границы порогов включаются в верхний диапазон', () => {
    // Самое вероятное место ошибки: 90 — это «4», а не «2», и 100 — «5», а не «4».
    expect(coinsForWeekSum(89)).not.toBe(coinsForWeekSum(90));
    expect(coinsForWeekSum(99)).not.toBe(coinsForWeekSum(100));
  });

  it('пороги перечислены по убыванию — от этого зависит выбор первого подошедшего', () => {
    const bounds = COIN_AWARD_THRESHOLDS.map((threshold) => threshold.minSum);

    expect(bounds).toEqual([...bounds].sort((a, b) => b - a));
  });
});
