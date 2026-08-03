import { Injectable, Logger } from '@nestjs/common';

import { MailingDispatcher } from '../mailings/mailing-dispatcher';
import { MailingsRepository } from '../mailings/mailings.repository';

/**
 * Порог «зависания»: доставка `PENDING` считается потерянной, только если ей
 * больше пятнадцати минут. Свежие `PENDING` — это те, что воркер просто ещё
 * не успел взять, и трогать их незачем.
 */
export const STUCK_THRESHOLD_MS = 15 * 60 * 1000;

/** Потолок одного прохода уборки — чтобы задача не тянула всю таблицу разом. */
export const SWEEP_LIMIT = 1000;

/**
 * Уборка зависших доставок (закрывает долг «повтор зависших запускается только
 * руками», 0036).
 *
 * `PENDING` у уже отправленной рассылки, провисевший дольше порога, — это задача,
 * которая до очереди не дошла (приложение упало между фиксацией транзакции
 * и `addBulk`) или в ней потерялась. Раньше её поднимал только оператор кнопкой
 * `retry`; теперь суточная задача делает это сама. Двойной задачи бояться
 * не нужно: обработчик берёт только `PENDING` и после первой же успешной
 * отправки второй заход пропускает (то же свойство, что делает `retry`
 * безопасным, 0036).
 */
@Injectable()
export class DeliverySweepService {
  private readonly logger = new Logger(DeliverySweepService.name);

  constructor(
    private readonly repository: MailingsRepository,
    private readonly dispatcher: MailingDispatcher,
  ) {}

  async sweep(now: Date): Promise<{ requeued: number }> {
    const before = new Date(now.getTime() - STUCK_THRESHOLD_MS);
    const ids = await this.repository.findStuckPendingIds(before, SWEEP_LIMIT);

    if (ids.length === 0) return { requeued: 0 };

    await this.dispatcher.enqueue(ids);
    this.logger.warn(`Уборка доставок: повторно поставлено в очередь ${String(ids.length)}`);

    return { requeued: ids.length };
  }
}
