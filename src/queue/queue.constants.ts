/** Имена очередей BullMQ. */
export const QUEUE_NAMES = {
  /** Отправка уведомлений (Telegram/SMS/почта) — наполняется рассылками (ТЗ 5.19). */
  Notifications: 'notifications',
  /**
   * Повторяющиеся задачи по расписанию (ТЗ 3.4): поздравления с ДР, уборка
   * зависших доставок, автозакрытие месяца рейтинга. Отдельная очередь от
   * `notifications`: у неё свой обработчик и своя частота, и мешать в одну
   * очередь «доставить одному человеку» и «пройтись по всей базе раз в сутки»
   * значило бы делить их между воркерами наугад.
   */
  Scheduled: 'scheduled',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Имена задач.
 *
 * `MailingDeliver` — единица работы очереди `notifications`: **одна доставка
 * одному человеку**, а не вся рассылка (решение пользователя). Остальные —
 * тики очереди `scheduled`: суточный (поздравления + уборка) и месячный
 * (закрытие рейтинга).
 */
export const JOB_NAMES = {
  MailingDeliver: 'mailing.deliver',
  DailyTasks: 'scheduled.daily',
  MonthlyTasks: 'scheduled.monthly',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/** Полезная нагрузка задачи доставки. */
export interface MailingDeliverJob {
  notificationId: string;
}

/**
 * Идентификаторы повторяющихся расписаний (Job Scheduler, BullMQ v5) и их cron.
 *
 * Время в cron — по UTC (BullMQ считает от системных часов). Суточная задача
 * стоит на 04:00 UTC = 09:00 в поясе центра (UTC+5): именинников отбирают утром
 * по местному времени. Месячная — 05:00 UTC первого числа, когда прошлый месяц
 * уже точно закончился в любом поясе.
 */
export const SCHEDULES = {
  Daily: { id: 'scheduled-daily', pattern: '0 4 * * *' },
  Monthly: { id: 'scheduled-monthly', pattern: '0 5 1 * *' },
} as const;
