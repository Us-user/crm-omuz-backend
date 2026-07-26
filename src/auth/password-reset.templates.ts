import { Locale } from '@prisma/client';

import type { MailMessage } from '../mailer';

/**
 * Письмо с кодом восстановления на языке аккаунта (ТЗ 3.3).
 * Полноценный движок шаблонов появится в Фазе 11 вместе с рассылками —
 * здесь достаточно трёх текстов, зато уведомление сразу локализовано.
 */
type Template = (code: string, minutes: number) => { subject: string; text: string };

const TEMPLATES: Record<Locale, Template> = {
  [Locale.RU]: (code, minutes) => ({
    subject: 'Восстановление пароля — CRM Omuz',
    text:
      `Код для смены пароля: ${code}\n\n` +
      `Код действует ${String(minutes)} минут и используется один раз.\n` +
      'Если вы не запрашивали смену пароля, просто проигнорируйте это письмо — ' +
      'пароль останется прежним.',
  }),

  [Locale.EN]: (code, minutes) => ({
    subject: 'Password reset — CRM Omuz',
    text:
      `Your password reset code: ${code}\n\n` +
      `The code is valid for ${String(minutes)} minutes and can be used once.\n` +
      'If you did not request a password reset, ignore this email — your password stays unchanged.',
  }),

  [Locale.TG]: (code, minutes) => ({
    subject: 'Барқарорсозии парол — CRM Omuz',
    text:
      `Рамз барои иваз кардани парол: ${code}\n\n` +
      `Рамз ${String(minutes)} дақиқа эътибор дорад ва танҳо як бор истифода мешавад.\n` +
      'Агар шумо иваз кардани паролро дархост накарда бошед, ин номаро нодида гиред — ' +
      'пароли шумо тағйир намеёбад.',
  }),
};

export function renderPasswordResetEmail(params: {
  to: string;
  locale: Locale;
  code: string;
  ttlSeconds: number;
}): MailMessage {
  const render = TEMPLATES[params.locale];
  const { subject, text } = render(params.code, Math.round(params.ttlSeconds / 60));

  return { to: params.to, subject, text };
}
