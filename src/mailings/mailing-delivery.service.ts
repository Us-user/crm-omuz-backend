import { Injectable, Logger } from '@nestjs/common';
import { NotificationStatus } from '@prisma/client';

import { MessageSender, PermanentDeliveryError } from '../messaging';
import { MailingsRepository } from './mailings.repository';

/** Чем кончилась попытка доставки — этим же значением она называется в логе. */
export enum DeliveryOutcome {
  /** Доставлено. */
  Sent = 'sent',
  /** Строка уже не в состоянии `PENDING` — задача пришла повторно. */
  Skipped = 'skipped',
  /** Окончательный отказ: помечено `FAILED`, повторять нечего. */
  Failed = 'failed',
  /** Временный отказ: попытка учтена, задачу нужно повторить. */
  Retry = 'retry',
}

/**
 * Доставка одного сообщения — то, что делает обработчик очереди.
 *
 * Вынесено из процессора отдельным сервисом намеренно: процессор — это
 * связка с BullMQ, и правила «повторно пришедшая задача не шлёт второй раз»,
 * «последняя попытка помечает отказ» проверялись бы только с живым Redis.
 * Здесь они проверяются юнит-тестами, а e2e прогоняет их по полному
 * HTTP-пути, подменив диспетчер синхронным.
 */
@Injectable()
export class MailingDeliveryService {
  private readonly logger = new Logger(MailingDeliveryService.name);

  constructor(
    private readonly repository: MailingsRepository,
    private readonly sender: MessageSender,
  ) {}

  /**
   * @param lastAttempt последняя ли это попытка очереди. На последней отказ
   *   записывается в строку доставки (`FAILED`); до неё — только учитывается,
   *   и задача уходит на повтор.
   */
  async deliver(notificationId: string, lastAttempt: boolean): Promise<DeliveryOutcome> {
    const delivery = await this.repository.findDelivery(notificationId);

    // Строки нет или её уже обработали. Это не ошибка: задача могла прийти
    // второй раз (BullMQ гарантирует «хотя бы один раз», а не «ровно один»),
    // и отправить повторно значило бы написать человеку дважды.
    if (!delivery || delivery.status !== NotificationStatus.PENDING) {
      return DeliveryOutcome.Skipped;
    }

    const attempts = delivery.attempts + 1;

    try {
      await this.sender.send({
        channel: delivery.channel,
        address: delivery.address,
        title: delivery.mailing.title,
        body: delivery.mailing.body,
      });
    } catch (error) {
      const reason = messageOf(error);

      // Отказ, про который известно, что он не пройдёт и со второго раза
      // (неверный адрес), записывается сразу: три попытки подряд вернули бы
      // тот же ответ, а получатель всё это время числился бы «в очереди».
      if (error instanceof PermanentDeliveryError || lastAttempt) {
        await this.repository.markDeliveryFailed(delivery.id, attempts, reason);
        this.logger.warn(`Доставка ${delivery.id} не удалась: ${reason}`);

        return DeliveryOutcome.Failed;
      }

      await this.repository.registerAttempt(delivery.id, attempts, reason);

      return DeliveryOutcome.Retry;
    }

    await this.repository.markDelivered(delivery.id, attempts, new Date());

    return DeliveryOutcome.Sent;
  }
}

/** Текст отказа: `Error` — его сообщение, что угодно другое — строкой. */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
