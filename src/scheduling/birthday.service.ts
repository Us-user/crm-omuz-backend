import { Injectable, Logger } from '@nestjs/common';
import { MessageChannel } from '@prisma/client';

import { AppConfigService } from '../config';
import { MailingsRepository } from '../mailings/mailings.repository';
import type { SystemRecipient } from '../mailings/system-mailing.service';
import { SystemMailingService } from '../mailings/system-mailing.service';
import { birthdaySystemKey, centerToday } from './scheduling';

/** Имя шаблона поздравления. Есть активный шаблон с таким именем — берётся он. */
export const BIRTHDAY_TEMPLATE_NAME = 'Поздравление с днём рождения';

/**
 * Встроенные заголовок и текст на случай, когда шаблона нет. Поздравление
 * работает «из коробки», а центр может переписать его обычным CRUD шаблонов
 * (ТЗ 5.19), заведя активный шаблон с зарезервированным именем.
 */
export const DEFAULT_BIRTHDAY_TITLE = 'С днём рождения! 🎉';
export const DEFAULT_BIRTHDAY_BODY =
  'С днём рождения, {{firstName}}! Команда учебного центра Omuz желает успехов ' +
  'в учёбе и ярких открытий. 🎉';

/** Итог одного прогона поздравлений — уходит в лог и в отчёт задачи. */
export interface BirthdayRunResult {
  /** Дата (в поясе центра), за которую поздравляли. */
  date: string;
  /** Сколько именинников нашлось. */
  birthdays: number;
  /** Завела ли эта попытка рассылку (`false` — за сегодня уже сделано). */
  created: boolean;
  /** Сколько поздравлений ушло в очередь. */
  queued: number;
  /** Сколько именинников без адреса канала (`SKIPPED`). */
  skipped: number;
}

/**
 * Поздравления с днём рождения (ТЗ 3.4: «Поздравления с ДР — частный случай»
 * модуля рассылок).
 *
 * Логика вся здесь и проверяется без Redis: обработчик очереди лишь вызывает
 * `congratulate` (тот же приём, что у доставки, 0036). Момент времени приходит
 * параметром — «сегодня» в поясе центра вычисляется из него, а не из скрытого
 * `new Date()`, поэтому прогон за любой день воспроизводим в тесте.
 *
 * Идемпотентность и «догон за сегодня» держатся на `SystemMailingService`:
 * ключ `birthday:YYYY-MM-DD` уникален, и повторный прогон (по расписанию или
 * при старте после простоя) второго поздравления не шлёт.
 */
@Injectable()
export class BirthdayService {
  private readonly logger = new Logger(BirthdayService.name);

  constructor(
    private readonly repository: MailingsRepository,
    private readonly system: SystemMailingService,
    private readonly config: AppConfigService,
  ) {}

  async congratulate(now: Date): Promise<BirthdayRunResult> {
    const today = centerToday(now, this.config.centerUtcOffsetMinutes);
    const systemKey = birthdaySystemKey(today);
    const dateLabel = systemKey.slice('birthday:'.length);

    const students = await this.repository.findStudentsBornOn(today.month, today.day);
    if (students.length === 0) {
      this.logger.debug(`Именинников на ${dateLabel} нет`);

      return { date: dateLabel, birthdays: 0, created: false, queued: 0, skipped: 0 };
    }

    const template = await this.repository.findActiveTemplateByName(BIRTHDAY_TEMPLATE_NAME);
    const channel = template?.channel ?? MessageChannel.TELEGRAM;
    const title = template?.title ?? DEFAULT_BIRTHDAY_TITLE;
    const body = template?.body ?? DEFAULT_BIRTHDAY_BODY;

    const recipients: SystemRecipient[] = students.map((student) => ({
      recipientType: 'STUDENT',
      studentId: student.id,
      employeeId: null,
      leadId: null,
      firstName: student.firstName,
      lastName: student.lastName,
      telegram: student.telegram,
      phone: student.phone,
      email: student.email,
    }));

    const result = await this.system.dispatch({ systemKey, channel, title, body, recipients });

    this.logger.log(
      `Поздравления с ДР на ${dateLabel}: именинников ${String(students.length)}, ` +
        (result.created
          ? `в очередь ${String(result.queued)}, без адреса ${String(result.deliveries.skipped)}`
          : 'за сегодня уже отправлено — пропуск'),
    );

    return {
      date: dateLabel,
      birthdays: students.length,
      created: result.created,
      queued: result.queued,
      skipped: result.deliveries.skipped,
    };
  }
}
