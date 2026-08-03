import { ConflictException, Injectable, Logger } from '@nestjs/common';

import { BusinessRuleException } from '../common';
import { DEFAULT_WINNER_PLACES } from '../leaders/leaders';
import { LeadersService } from '../leaders/leaders.service';
import { previousUtcMonth } from './scheduling';

/**
 * Идентификатор «системного» инициатора закрытия. Аккаунта с таким id нет,
 * поэтому `closeMonth` не найдёт сотрудника и запишет автора снимка как `null` —
 * ровно то, что нужно: месяц закрыла система, а не человек. Формат UUID
 * обязателен: `accountId` — колонка `@db.Uuid`, и строка не того вида упала бы
 * ещё до запроса.
 */
const SYSTEM_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000';

/** Итог попытки автозакрытия — уходит в лог и в отчёт задачи. */
export interface RatingCloseResult {
  month: string;
  closed: boolean;
  /** Почему не закрыли, если `closed === false` (уже закрыт / нет недель). */
  reason?: string;
}

/**
 * Автозакрытие месяца рейтинга (закрывает долг «месяц закрывается вручную»,
 * решение 0024: «работающих фоновых задач в проекте нет до Фазы 11»).
 *
 * Логика закрытия **переиспользуется** у `LeadersService.closeMonth`, а не
 * повторяется: снимок победителей касается того, кто чем награждён, и второй
 * его экземпляр разошёлся бы с ручным закрытием молча (тот же довод, что
 * у кабинета ментора с `AvansService`, 0023). Задача лишь выбирает **прошлый**
 * месяц и глушит два ожидаемых исхода:
 *   - `409` — месяц уже закрыли руками: повторять нечего, это успех идемпотентности;
 *   - `422` — в месяце нет ни одной финализированной недели: закрывать нечего.
 * Любая другая ошибка пробрасывается — молчать о ней было бы хуже.
 */
@Injectable()
export class RatingCloseService {
  private readonly logger = new Logger(RatingCloseService.name);

  constructor(private readonly leaders: LeadersService) {}

  async closeLastMonth(now: Date): Promise<RatingCloseResult> {
    const month = previousUtcMonth(now);

    try {
      const result = await this.leaders.closeMonth(
        { month, places: DEFAULT_WINNER_PLACES },
        SYSTEM_ACCOUNT_ID,
      );
      this.logger.log(
        `Месяц рейтинга ${month} закрыт автоматически: победителей ${String(result.winners.length)}`,
      );

      return { month, closed: true };
    } catch (error) {
      if (error instanceof ConflictException) {
        this.logger.debug(`Месяц рейтинга ${month} уже был закрыт — автозакрытие пропущено`);

        return { month, closed: false, reason: 'already-closed' };
      }
      if (error instanceof BusinessRuleException) {
        this.logger.debug(`Месяц рейтинга ${month} закрывать нечем: нет финализированных недель`);

        return { month, closed: false, reason: 'no-weeks' };
      }

      throw error;
    }
  }
}
