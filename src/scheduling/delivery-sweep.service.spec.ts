import type { MailingsRepository } from '../mailings/mailings.repository';
import { DeliverySweepService, STUCK_THRESHOLD_MS } from './delivery-sweep.service';

const build = (stuck: string[]) => {
  const repo = { findStuckPendingIds: jest.fn().mockResolvedValue(stuck) };
  const dispatcher = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const service = new DeliverySweepService(repo as unknown as MailingsRepository, dispatcher);

  return { service, repo, dispatcher };
};

describe('DeliverySweepService', () => {
  const now = new Date('2026-08-03T04:00:00.000Z');

  it('зависшие доставки возвращаются в очередь', async () => {
    const { service, repo, dispatcher } = build(['n1', 'n2']);

    const result = await service.sweep(now);

    // Порог: искать созданные раньше, чем 15 минут назад.
    expect(repo.findStuckPendingIds).toHaveBeenCalledWith(
      new Date(now.getTime() - STUCK_THRESHOLD_MS),
      expect.any(Number),
    );
    expect(dispatcher.enqueue).toHaveBeenCalledWith(['n1', 'n2']);
    expect(result).toEqual({ requeued: 2 });
  });

  it('нет зависших — очередь не трогается', async () => {
    const { service, dispatcher } = build([]);

    const result = await service.sweep(now);

    expect(dispatcher.enqueue).not.toHaveBeenCalled();
    expect(result).toEqual({ requeued: 0 });
  });
});
