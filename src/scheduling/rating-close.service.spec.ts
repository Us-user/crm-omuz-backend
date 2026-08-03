import { ConflictException } from '@nestjs/common';

import { BusinessRuleException } from '../common';
import { DEFAULT_WINNER_PLACES } from '../leaders/leaders';
import type { LeadersService } from '../leaders/leaders.service';
import { RatingCloseService } from './rating-close.service';

const build = (closeMonth: jest.Mock) => {
  const leaders = { closeMonth } as unknown as LeadersService;

  return { service: new RatingCloseService(leaders), closeMonth };
};

describe('RatingCloseService', () => {
  // 2026-08-15 → закрываем прошлый месяц 2026-07.
  const now = new Date('2026-08-15T05:00:00.000Z');

  it('закрывает прошлый месяц числом мест по умолчанию', async () => {
    const { service, closeMonth } = build(jest.fn().mockResolvedValue({ winners: [{}, {}, {}] }));

    const result = await service.closeLastMonth(now);

    expect(closeMonth).toHaveBeenCalledWith(
      { month: '2026-07', places: DEFAULT_WINNER_PLACES },
      expect.any(String),
    );
    expect(result).toEqual({ month: '2026-07', closed: true });
  });

  it('уже закрыт (409) — тихий пропуск', async () => {
    const { service } = build(jest.fn().mockRejectedValue(new ConflictException('уже закрыт')));

    const result = await service.closeLastMonth(now);

    expect(result).toEqual({ month: '2026-07', closed: false, reason: 'already-closed' });
  });

  it('нет финализированных недель (422) — закрывать нечего', async () => {
    const { service } = build(jest.fn().mockRejectedValue(new BusinessRuleException('нет недель')));

    const result = await service.closeLastMonth(now);

    expect(result).toEqual({ month: '2026-07', closed: false, reason: 'no-weeks' });
  });

  it('прочая ошибка пробрасывается', async () => {
    const { service } = build(jest.fn().mockRejectedValue(new Error('БД недоступна')));

    await expect(service.closeLastMonth(now)).rejects.toThrow('БД недоступна');
  });
});
