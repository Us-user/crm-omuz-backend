import {
  DEFAULT_WINNER_PLACES,
  MAX_WINNER_PLACES,
  rankByScore,
  type ScoredStudent,
  takePlaces,
} from './leaders';

const scored = (studentId: string, average: number, weeksCount = 1): ScoredStudent => ({
  studentId,
  average,
  weeksCount,
});

describe('rankByScore', () => {
  it('расставляет места по убыванию балла', () => {
    const ranked = rankByScore([scored('b', 80), scored('a', 95), scored('c', 60)]);

    expect(ranked.map(({ studentId, place }) => [studentId, place])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
  });

  // Правило сессии 0019: место — «сколько строго выше, плюс один».
  it('при равенстве баллов место одно на двоих, а следующий получает третье', () => {
    const ranked = rankByScore([scored('a', 90), scored('b', 90), scored('c', 70)]);

    expect(ranked.map(({ place }) => place)).toEqual([1, 1, 3]);
  });

  it('весь список с одинаковым баллом занимает одно место', () => {
    const ranked = rankByScore([scored('a', 50), scored('b', 50), scored('c', 50)]);

    expect(ranked.map(({ place }) => place)).toEqual([1, 1, 1]);
  });

  // Округление — дело показа: 87.334 и 87.335 показываются одинаково,
  // но первым должен быть один.
  it('сравнивает по неокруглённому баллу', () => {
    const ranked = rankByScore([scored('a', 87.334), scored('b', 87.335)]);

    expect(ranked.map(({ studentId, place }) => [studentId, place])).toEqual([
      ['b', 1],
      ['a', 2],
    ]);
  });

  // Список постраничный: без устойчивого порядка одна строка пришла бы дважды.
  it('внутри одного места порядок задан идентификатором, а не входным', () => {
    const forward = rankByScore([scored('b', 90), scored('a', 90)]);
    const backward = rankByScore([scored('a', 90), scored('b', 90)]);

    expect(forward.map(({ studentId }) => studentId)).toEqual(['a', 'b']);
    expect(backward.map(({ studentId }) => studentId)).toEqual(['a', 'b']);
  });

  it('не зависит от порядка входного списка', () => {
    const rows = [scored('a', 95), scored('b', 80), scored('c', 60)];
    const reversed = rankByScore([...rows].reverse());

    expect(reversed).toEqual(rankByScore(rows));
  });

  it('сохраняет число учтённых недель', () => {
    const [first] = rankByScore([scored('a', 95, 4)]);

    expect(first).toMatchObject({ studentId: 'a', place: 1, weeksCount: 4 });
  });

  it('пустой список даёт пустой рейтинг', () => {
    expect(rankByScore([])).toEqual([]);
  });

  it('не меняет исходный массив', () => {
    const rows = [scored('b', 80), scored('a', 95)];
    rankByScore(rows);

    expect(rows.map(({ studentId }) => studentId)).toEqual(['b', 'a']);
  });

  it('нулевой балл — это место, а не отсутствие места', () => {
    const ranked = rankByScore([scored('a', 0), scored('b', 10)]);

    expect(ranked.map(({ studentId, place }) => [studentId, place])).toEqual([
      ['b', 1],
      ['a', 2],
    ]);
  });
});

describe('takePlaces', () => {
  it('оставляет первые N мест', () => {
    const ranked = rankByScore([
      scored('a', 100),
      scored('b', 90),
      scored('c', 80),
      scored('d', 70),
    ]);

    expect(takePlaces(ranked, 3).map(({ studentId }) => studentId)).toEqual(['a', 'b', 'c']);
  });

  // Обрезание списка до трёх строк выкинуло бы одного из двух одинаковых
  // по признаку, которого нет.
  it('при ничьей на последнем месте берёт всех, кто его занял', () => {
    const ranked = rankByScore([
      scored('a', 100),
      scored('b', 90),
      scored('c', 80),
      scored('d', 80),
    ]);
    const winners = takePlaces(ranked, 3);

    expect(winners).toHaveLength(4);
    expect(winners.map(({ place }) => place)).toEqual([1, 2, 3, 3]);
  });

  it('ничья на первом месте не съедает остальные места', () => {
    const ranked = rankByScore([scored('a', 90), scored('b', 90), scored('c', 50)]);

    // Места идут 1, 1, 3 — третье занято, второго не существует.
    expect(takePlaces(ranked, 3).map(({ studentId }) => studentId)).toEqual(['a', 'b', 'c']);
    expect(takePlaces(ranked, 2).map(({ studentId }) => studentId)).toEqual(['a', 'b']);
  });

  it('одно место оставляет только победителей', () => {
    const ranked = rankByScore([scored('a', 90), scored('b', 90), scored('c', 89)]);

    expect(takePlaces(ranked, 1).map(({ studentId }) => studentId)).toEqual(['a', 'b']);
  });

  it('список короче запрошенного числа мест отдаётся целиком', () => {
    const ranked = rankByScore([scored('a', 90)]);

    expect(takePlaces(ranked, 3)).toHaveLength(1);
  });

  it('пустой рейтинг даёт пустой срез', () => {
    expect(takePlaces([], 3)).toEqual([]);
  });
});

describe('границы снимка', () => {
  it('по умолчанию фиксируется топ-3 (ТЗ 5.13)', () => {
    expect(DEFAULT_WINNER_PLACES).toBe(3);
  });

  it('верхняя граница не меньше значения по умолчанию', () => {
    expect(MAX_WINNER_PLACES).toBeGreaterThanOrEqual(DEFAULT_WINNER_PLACES);
  });
});
