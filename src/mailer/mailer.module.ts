import { Global, Module } from '@nestjs/common';

import { LogMailerService } from './log-mailer.service';
import { MailerService } from './mailer.service';

/**
 * Отправка писем (ТЗ 3.4). Глобальный модуль: письма понадобятся не только
 * сбросу пароля, но и приглашениям студентов, рассылкам и отчётам.
 *
 * Провайдер выбирается здесь — прикладной код видит только `MailerService`.
 */
@Global()
@Module({
  providers: [{ provide: MailerService, useClass: LogMailerService }],
  exports: [MailerService],
})
export class MailerModule {}
