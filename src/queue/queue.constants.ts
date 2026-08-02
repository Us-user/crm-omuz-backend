/** Имена очередей BullMQ. */
export const QUEUE_NAMES = {
  /** Отправка уведомлений (Telegram/SMS/почта) — наполняется рассылками (ТЗ 5.19). */
  Notifications: 'notifications',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Имена задач внутри очереди уведомлений.
 *
 * Единица работы — **одна доставка одному человеку**, а не вся рассылка
 * (решение пользователя): при задаче «отправить рассылку» первый же отказ
 * провайдера на сотом получателе повторил бы всю тысячу с начала, разослав
 * первым девяносто девяти по второму сообщению.
 */
export const JOB_NAMES = {
  MailingDeliver: 'mailing.deliver',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/** Полезная нагрузка задачи доставки. */
export interface MailingDeliverJob {
  notificationId: string;
}
