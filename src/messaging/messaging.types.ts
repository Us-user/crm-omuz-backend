import type { MessageChannel } from '@prisma/client';

/** Сообщение в терминах, не зависящих от провайдера (ТЗ 3.4). */
export interface OutboundMessage {
  /** Куда отправлять: Telegram, SMS или почта. */
  channel: MessageChannel;

  /**
   * Адрес получателя в терминах канала: `@username` или chat-id для Telegram,
   * телефон E.164 для SMS, email для почты. Одна строка, а не три поля:
   * канал уже сказал, что именно в ней лежит, и второе поле «чем является
   * эта строка» повторяло бы его.
   */
  address: string;

  /**
   * Заголовок. У SMS его нет как такового — провайдер SMS склеивает
   * заголовок с телом, и это его дело, а не дело прикладного кода.
   */
  title: string;

  body: string;
}

/**
 * Отказ провайдера, о котором известно, что повторять бессмысленно
 * (неверный адрес, получатель не начинал диалог с ботом). Обработчик
 * доставки не отдаёт такую задачу очереди на повтор — три попытки подряд
 * вернули бы тот же ответ.
 */
export class PermanentDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentDeliveryError';
  }
}
