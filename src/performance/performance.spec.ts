import {
  ACTIVITY_CATEGORY_THRESHOLDS,
  ACTIVITY_CATEGORY_TITLES,
  ActivityCategory,
  activityCategoryOf,
  averageScore,
  countByCategory,
  isPassing,
  PASSING_MIN_SCORE,
  roundScore,
} from './performance';

describe('averageScore — общий балл (ТЗ 5.8)', () => {
  it('среднее Sum по неделям', () => {
    expect(averageScore([100, 90, 80])).toBe(90);
  });

  it('одна неделя даёт саму себя', () => {
    expect(averageScore([73])).toBe(73);
  });

  it('без недель балла нет — `null`, а не ноль', () => {
    // Ноль записал бы студента в Black list за то, что его группа
    // просто не дошла до первой финализации.
    expect(averageScore([])).toBeNull();
  });

  it('ноль за неделю от отсутствия недель отличается', () => {
    expect(averageScore([0])).toBe(0);
  });

  it('дробное среднее не округляется внутри правила', () => {
    // Округление — дело показа: сравнения рейтинга идут по полному значению.
    expect(averageScore([100, 99])).toBeCloseTo(99.5, 10);
    expect(averageScore([1, 1, 2])).toBeCloseTo(4 / 3, 10);
  });

  it('порядок недель на результат не влияет', () => {
    expect(averageScore([10, 50, 90])).toBe(averageScore([90, 10, 50]));
  });
});

describe('roundScore — округление для показа', () => {
  it('до двух знаков', () => {
    expect(roundScore(4 / 3)).toBe(1.33);
    expect(roundScore(99.555)).toBe(99.56);
  });

  it('целое остаётся целым', () => {
    expect(roundScore(90)).toBe(90);
  });
});

describe('activityCategoryOf — категории активности (ТЗ 5.5)', () => {
  it.each([
    [100, ActivityCategory.ChatGpt],
    [95, ActivityCategory.ChatGpt],
    [94.99, ActivityCategory.Handsome],
    [80, ActivityCategory.Handsome],
    [79.99, ActivityCategory.Advanced],
    [65, ActivityCategory.Advanced],
    [64.99, ActivityCategory.Kettle],
    [45, ActivityCategory.Kettle],
    [44.99, ActivityCategory.BlackList],
    [0, ActivityCategory.BlackList],
  ])('балл %p → %s', (score, category) => {
    expect(activityCategoryOf(score)).toBe(category);
  });

  it('границы включаются в верхнюю категорию, а не в нижнюю', () => {
    // ТЗ 5.5 пишет диапазоны как «80–94»: 94 ещё Handsome, 95 уже ChatGPT.
    expect(activityCategoryOf(94)).toBe(ActivityCategory.Handsome);
    expect(activityCategoryOf(95)).toBe(ActivityCategory.ChatGpt);
    expect(activityCategoryOf(64)).toBe(ActivityCategory.Kettle);
    expect(activityCategoryOf(65)).toBe(ActivityCategory.Advanced);
  });

  it('без балла категории нет', () => {
    expect(activityCategoryOf(null)).toBeNull();
  });

  it('пороги перечислены по убыванию — иначе первый подошедший был бы не тот', () => {
    const scores = ACTIVITY_CATEGORY_THRESHOLDS.map(({ minScore }) => minScore);

    expect(scores).toStrictEqual([...scores].sort((a, b) => b - a));
  });

  it('у каждой категории есть название из ТЗ 5.5', () => {
    expect(
      Object.values(ActivityCategory).every((c) => ACTIVITY_CATEGORY_TITLES[c].length > 0),
    ).toBe(true);
    expect(ACTIVITY_CATEGORY_TITLES[ActivityCategory.BlackList]).toBe('Black list');
  });
});

describe('isPassing — «Passing students» (ТЗ 5.5)', () => {
  it('проходной балл выведен из таблицы категорий, а не задан вторым числом', () => {
    expect(PASSING_MIN_SCORE).toBe(45);
  });

  it('успевающий — всякий, кто не в Black list', () => {
    expect(isPassing(45)).toBe(true);
    expect(isPassing(44.99)).toBe(false);
    expect(isPassing(100)).toBe(true);
  });

  it('не оценённый не считается успевающим', () => {
    // Иначе счётчик успевающих рос бы за счёт тех, кого не оценивали.
    expect(isPassing(null)).toBe(false);
  });

  it('порог совпадает с нижней границей категории Kettle', () => {
    expect(activityCategoryOf(PASSING_MIN_SCORE)).toBe(ActivityCategory.Kettle);
    expect(activityCategoryOf(PASSING_MIN_SCORE - 0.01)).toBe(ActivityCategory.BlackList);
  });
});

describe('countByCategory — счётчики карточки группы (ТЗ 5.5)', () => {
  it('раскладывает баллы по категориям', () => {
    const counts = countByCategory([100, 96, 82, 70, 50, 10]);

    expect(counts).toStrictEqual({
      [ActivityCategory.ChatGpt]: 2,
      [ActivityCategory.Handsome]: 1,
      [ActivityCategory.Advanced]: 1,
      [ActivityCategory.Kettle]: 1,
      [ActivityCategory.BlackList]: 1,
      unscored: 0,
    });
  });

  it('не оценённые идут в `unscored`, а не в Black list', () => {
    const counts = countByCategory([null, null, 30]);

    expect(counts.unscored).toBe(2);
    expect(counts[ActivityCategory.BlackList]).toBe(1);
  });

  it('пустой состав даёт нули, а не пустой объект', () => {
    const counts = countByCategory([]);

    expect(counts).toStrictEqual({
      [ActivityCategory.ChatGpt]: 0,
      [ActivityCategory.Handsome]: 0,
      [ActivityCategory.Advanced]: 0,
      [ActivityCategory.Kettle]: 0,
      [ActivityCategory.BlackList]: 0,
      unscored: 0,
    });
  });

  it('сумма счётчиков равна числу студентов', () => {
    const scores = [100, 80, null, 44, 65, null];
    const counts = countByCategory(scores);
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

    expect(total).toBe(scores.length);
  });
});
