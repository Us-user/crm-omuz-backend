import { Locale } from '@prisma/client';

import type { MailMessage } from '../mailer';

/**
 * Письмо-приглашение на языке аккаунта (ТЗ 3.3, 5.3: Invite).
 *
 * Отдельно от письма сброса пароля (`src/auth/password-reset.templates.ts`),
 * хотя код внутри тот же самый: студент видит эти письма в разных ситуациях —
 * «вам открыли доступ» и «вы забыли пароль», — и общий текст был бы неверен
 * в обоих случаях. Логин называется прямо: это его контактный телефон, и без
 * подсказки человек начнёт вводить email, которым получил письмо.
 */
type Template = (params: { login: string; code: string; minutes: number }) => {
  subject: string;
  text: string;
};

const TEMPLATES: Record<Locale, Template> = {
  [Locale.RU]: ({ login, code, minutes }) => ({
    subject: 'Доступ в CRM Omuz',
    text:
      'Вам открыт доступ в систему учебного центра «Omuz».\n\n' +
      `Логин: ${login}\n` +
      `Код для установки пароля: ${code}\n\n` +
      `Код действует ${String(minutes)} минут и используется один раз. ` +
      'Задайте пароль по нему и войдите с этим логином.\n' +
      'Если код истёк, запросите новый на странице восстановления пароля.',
  }),

  [Locale.EN]: ({ login, code, minutes }) => ({
    subject: 'Your access to CRM Omuz',
    text:
      'You have been granted access to the Omuz learning center system.\n\n' +
      `Login: ${login}\n` +
      `Password setup code: ${code}\n\n` +
      `The code is valid for ${String(minutes)} minutes and can be used once. ` +
      'Use it to set your password, then sign in with the login above.\n' +
      'If the code has expired, request a new one on the password recovery page.',
  }),

  [Locale.TG]: ({ login, code, minutes }) => ({
    subject: 'Дастрасӣ ба CRM Omuz',
    text:
      'Ба шумо дастрасӣ ба системаи маркази таълимии «Omuz» дода шуд.\n\n' +
      `Логин: ${login}\n` +
      `Рамз барои муқаррар кардани парол: ${code}\n\n` +
      `Рамз ${String(minutes)} дақиқа эътибор дорад ва танҳо як бор истифода мешавад. ` +
      'Бо он паролро муқаррар кунед ва бо ҳамин логин ворид шавед.\n' +
      'Агар мӯҳлати рамз гузашта бошад, дар саҳифаи барқарорсозии парол рамзи навро дархост кунед.',
  }),
};

export function renderStudentInviteEmail(params: {
  to: string;
  locale: Locale;
  login: string;
  code: string;
  ttlSeconds: number;
}): MailMessage {
  const { subject, text } = TEMPLATES[params.locale]({
    login: params.login,
    code: params.code,
    minutes: Math.round(params.ttlSeconds / 60),
  });

  return { to: params.to, subject, text };
}
