import { MessageChannel } from '@prisma/client';

import type { AppConfigService } from '../config';
import type { MailingsRepository } from '../mailings/mailings.repository';
import type { SystemMailingService } from '../mailings/system-mailing.service';
import { BirthdayService, DEFAULT_BIRTHDAY_BODY, DEFAULT_BIRTHDAY_TITLE } from './birthday.service';

const build = (opts: {
  students?: {
    id: string;
    firstName: string;
    lastName: string;
    telegram: string | null;
    phone: string | null;
    email: string | null;
  }[];
  template?: { title: string; body: string; channel: MessageChannel | null } | null;
}) => {
  const repo = {
    findStudentsBornOn: jest.fn().mockResolvedValue(opts.students ?? []),
    findActiveTemplateByName: jest.fn().mockResolvedValue(opts.template ?? null),
  };
  const system = {
    dispatch: jest.fn().mockResolvedValue({
      created: true,
      deliveries: { total: 1, pending: 1, sent: 0, failed: 0, skipped: 0 },
      queued: 1,
    }),
  };
  const config = { centerUtcOffsetMinutes: 300 } as unknown as AppConfigService;

  const service = new BirthdayService(
    repo as unknown as MailingsRepository,
    system as unknown as SystemMailingService,
    config,
  );

  return { service, repo, system };
};

const someStudent = {
  id: 's1',
  firstName: 'Умед',
  lastName: 'Каримов',
  telegram: '@umed',
  phone: null,
  email: null,
};

describe('BirthdayService', () => {
  // 2026-08-02 21:00 UTC = 2026-08-03 в поясе центра (UTC+5).
  const now = new Date('2026-08-02T21:00:00.000Z');

  it('нет именинников — рассылка не заводится', async () => {
    const { service, repo, system } = build({ students: [] });

    const result = await service.congratulate(now);

    expect(repo.findStudentsBornOn).toHaveBeenCalledWith(8, 3);
    expect(system.dispatch).not.toHaveBeenCalled();
    expect(result).toEqual({
      date: '2026-08-03',
      birthdays: 0,
      created: false,
      queued: 0,
      skipped: 0,
    });
  });

  it('без шаблона берёт встроенный текст и канал Telegram', async () => {
    const { service, system } = build({ students: [someStudent] });

    const result = await service.congratulate(now);

    expect(system.dispatch).toHaveBeenCalledTimes(1);
    const arg = system.dispatch.mock.calls[0][0];
    expect(arg.systemKey).toBe('birthday:2026-08-03');
    expect(arg.channel).toBe(MessageChannel.TELEGRAM);
    expect(arg.title).toBe(DEFAULT_BIRTHDAY_TITLE);
    expect(arg.body).toBe(DEFAULT_BIRTHDAY_BODY);
    expect(arg.recipients).toEqual([
      {
        recipientType: 'STUDENT',
        studentId: 's1',
        employeeId: null,
        leadId: null,
        firstName: 'Умед',
        lastName: 'Каримов',
        telegram: '@umed',
        phone: null,
        email: null,
      },
    ]);
    expect(result.birthdays).toBe(1);
    expect(result.created).toBe(true);
  });

  it('активный шаблон переопределяет текст и канал', async () => {
    const { service, system } = build({
      students: [someStudent],
      template: {
        title: 'С праздником',
        body: 'Дорогой {{firstName}}!',
        channel: MessageChannel.SMS,
      },
    });

    await service.congratulate(now);

    const arg = system.dispatch.mock.calls[0][0];
    expect(arg.channel).toBe(MessageChannel.SMS);
    expect(arg.title).toBe('С праздником');
    expect(arg.body).toBe('Дорогой {{firstName}}!');
  });
});
