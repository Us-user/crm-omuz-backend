/** Письмо в терминах, не зависящих от провайдера. */
export interface MailMessage {
  /** Адрес получателя. */
  to: string;
  subject: string;
  /** Текстовое тело. HTML-версия появится вместе с шаблонами Фазы 12. */
  text: string;
}
