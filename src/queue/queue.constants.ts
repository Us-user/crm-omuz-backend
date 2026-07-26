/** Имена очередей BullMQ. */
export const QUEUE_NAMES = {
  /** Отправка уведомлений (Telegram/SMS) — наполняется в Фазе 11. */
  Notifications: 'notifications',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
