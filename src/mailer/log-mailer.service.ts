import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { AppConfigService } from '../config';
import { MailerService } from './mailer.service';
import type { MailMessage } from './mailer.types';

/**
 * Реализация-заглушка: письмо не уходит наружу, а пишется в лог.
 * Нужна, пока не подключён реальный провайдер (Фаза 11 — «отправитель сообщений»).
 *
 * Тело пишется на уровне `debug`, а не `info`: в письме сброса пароля лежит
 * одноразовый код, и на проде (`LOG_LEVEL=info`) он не должен оседать в логах.
 * То есть без настоящего провайдера сброс пароля в проде не работает — и это
 * честнее, чем тихо рассылать коды через журнал.
 */
@Injectable()
export class LogMailerService extends MailerService implements OnModuleInit {
  private readonly logger = new Logger('Mailer');

  constructor(private readonly config: AppConfigService) {
    super();
  }

  onModuleInit(): void {
    if (this.config.isTest) return;

    this.logger.warn(
      'Отправитель писем не настроен: письма только пишутся в лог (уровень debug). ' +
        'Реальный провайдер подключается в Фазе 11.',
    );
  }

  send(message: MailMessage): Promise<void> {
    this.logger.debug(
      `Письмо (не отправлено, провайдер не настроен): ` +
        `from=${this.config.mailFrom} to=${message.to} subject=${message.subject}\n${message.text}`,
    );

    return Promise.resolve();
  }
}
