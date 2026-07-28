import { LeadType } from '@prisma/client';

import { becameClientAtOf } from './leads';

const NOW = new Date('2026-09-02T08:30:00.000Z');

describe('becameClientAtOf (ТЗ 5.7)', () => {
  it('стадия не передана — колонку не трогаем', () => {
    expect(becameClientAtOf(LeadType.LEAD, undefined, NOW)).toBeUndefined();
    expect(becameClientAtOf(LeadType.CLIENT, undefined, NOW)).toBeUndefined();
  });

  it('та же стадия — колонку не трогаем: сохранение карточки не переписывает дату', () => {
    expect(becameClientAtOf(LeadType.CLIENT, LeadType.CLIENT, NOW)).toBeUndefined();
    expect(becameClientAtOf(LeadType.LEAD, LeadType.LEAD, NOW)).toBeUndefined();
  });

  it('LEAD → CLIENT проставляет дату перехода', () => {
    expect(becameClientAtOf(LeadType.LEAD, LeadType.CLIENT, NOW)).toEqual(NOW);
  });

  it('CLIENT → LEAD снимает дату: иначе осталась бы дата перехода, которого нет', () => {
    expect(becameClientAtOf(LeadType.CLIENT, LeadType.LEAD, NOW)).toBeNull();
  });

  it('различает `undefined` («не трогать») и `null` («снять») — это разные состояния', () => {
    const untouched = becameClientAtOf(LeadType.CLIENT, undefined, NOW);
    const cleared = becameClientAtOf(LeadType.CLIENT, LeadType.LEAD, NOW);

    expect(untouched).toBeUndefined();
    expect(cleared).toBeNull();
    expect(untouched).not.toBe(cleared);
  });
});
