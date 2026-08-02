import { Global, Module } from '@nestjs/common';

import { DefaultMessageSender } from './default-message-sender.service';
import { MessageSender } from './message-sender.service';

/**
 * Отправка сообщений (ТЗ 3.4). Глобальный модуль по образцу `MailerModule`:
 * сообщения понадобятся не только рассылкам, но и поздравлениям с ДР,
 * напоминаниям об оплате и отчёту Директору при финализации недели (0018).
 *
 * Провайдер выбирается **здесь и только здесь** — прикладной код видит
 * лишь контракт `MessageSender`.
 */
@Global()
@Module({
  providers: [{ provide: MessageSender, useClass: DefaultMessageSender }],
  exports: [MessageSender],
})
export class MessagingModule {}
