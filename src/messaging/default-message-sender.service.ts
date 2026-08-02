import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MessageChannel } from '@prisma/client';

import { AppConfigService } from '../config';
import { MailerService } from '../mailer';
import { MessageSender } from './message-sender.service';
import type { OutboundMessage } from './messaging.types';

/**
 * Отправитель по умолчанию.
 *
 * Почта уходит **через `MailerService`** — канал в проекте работает с Фазы 1,
 * и заводить рядом с ним второй способ отправить письмо значило бы держать
 * два места, где решается, каким провайдером пользуется центр.
 *
 * Telegram и SMS провайдера пока не имеют и пишутся в лог на уровне `debug` —
 * ровно как письма в `LogMailerService` (0003). Уровень `debug`, а не `info`,
 * по той же причине: в сообщении бывает то, чему не место в журнале прода.
 *
 * Честная цена названа и в логе, и в предупреждении при старте: пока провайдера
 * нет, «Send» рассылки помечает доставку выполненной, хотя наружу ничего
 * не ушло. Это осознанно оставлено видимым, а не спрятано — сессии 0018, 0024,
 * 0026 и 0029 по тому же соображению отказывались ставить задачи в очередь,
 * у которой нет обработчика.
 */
@Injectable()
export class DefaultMessageSender extends MessageSender implements OnModuleInit {
  private readonly logger = new Logger('MessageSender');

  constructor(
    private readonly config: AppConfigService,
    private readonly mailer: MailerService,
  ) {
    super();
  }

  onModuleInit(): void {
    if (this.config.isTest) return;

    this.logger.warn(
      'Отправитель сообщений не настроен: Telegram и SMS только пишутся в лог ' +
        '(уровень debug). Почта уходит тем же провайдером, что и письма Auth. ' +
        'Реальный провайдер подключается одним классом в MessagingModule.',
    );
  }

  async send(message: OutboundMessage): Promise<void> {
    if (message.channel === MessageChannel.EMAIL) {
      await this.mailer.send({
        to: message.address,
        subject: message.title,
        text: message.body,
      });

      return;
    }

    this.logger.debug(
      `Сообщение (не отправлено, провайдер не настроен): channel=${message.channel} ` +
        `to=${message.address} title=${message.title}\n${message.body}`,
    );
  }
}
