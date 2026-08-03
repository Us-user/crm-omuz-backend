import { MessageChannel, Prisma } from '@prisma/client';

import type { MailingsRepository } from './mailings.repository';
import { SystemMailingService, systemSeedOf, type SystemRecipient } from './system-mailing.service';

const student = (over: Partial<SystemRecipient> = {}): SystemRecipient => ({
  recipientType: 'STUDENT',
  studentId: 's1',
  employeeId: null,
  leadId: null,
  firstName: 'Умед',
  lastName: 'Каримов',
  telegram: '@umed',
  phone: null,
  email: null,
  ...over,
});

const build = (createResult: (() => Promise<string>) | Promise<string> = Promise.resolve('m1')) => {
  const repo = {
    createSystemMailing: jest.fn(() =>
      typeof createResult === 'function' ? createResult() : createResult,
    ),
  };
  const dispatcher = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const service = new SystemMailingService(repo as unknown as MailingsRepository, dispatcher);

  return { service, repo, dispatcher };
};

describe('SystemMailingService', () => {
  it('пустая аудитория: ни рассылки, ни задач', async () => {
    const { service, repo, dispatcher } = build();

    const result = await service.dispatch({
      systemKey: 'birthday:2026-08-03',
      channel: MessageChannel.TELEGRAM,
      title: 'С ДР',
      body: 'Поздравляем!',
      recipients: [],
    });

    expect(result).toEqual({ created: false, deliveries: expect.anything(), queued: 0 });
    expect(repo.createSystemMailing).not.toHaveBeenCalled();
    expect(dispatcher.enqueue).not.toHaveBeenCalled();
  });

  it('заводит рассылку и ставит в очередь только адресатов с адресом', async () => {
    const { service, repo, dispatcher } = build();

    const result = await service.dispatch({
      systemKey: 'birthday:2026-08-03',
      channel: MessageChannel.TELEGRAM,
      title: 'С ДР',
      body: 'С днём рождения, {{firstName}}!',
      recipients: [student(), student({ studentId: 's2', telegram: null })],
    });

    expect(result.created).toBe(true);
    expect(result.deliveries.total).toBe(2);
    expect(result.deliveries.skipped).toBe(1);
    expect(result.queued).toBe(1);

    const seeds = (
      repo.createSystemMailing.mock.calls[0] as unknown as [{ notifications: unknown[] }]
    )[0].notifications;
    expect(seeds).toHaveLength(2);
    // В очередь ушли только PENDING (у кого есть адрес).
    expect(dispatcher.enqueue).toHaveBeenCalledWith([expect.any(String)]);
    expect(dispatcher.enqueue.mock.calls[0][0]).toHaveLength(1);
  });

  it('повтор за ту же дату (P2002) ничего не шлёт', async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const { service, repo, dispatcher } = build(() => Promise.reject(conflict));

    const result = await service.dispatch({
      systemKey: 'birthday:2026-08-03',
      channel: MessageChannel.TELEGRAM,
      title: 'С ДР',
      body: 'Поздравляем!',
      recipients: [student()],
    });

    expect(result).toEqual({ created: false, deliveries: expect.anything(), queued: 0 });
    expect(repo.createSystemMailing).toHaveBeenCalledTimes(1);
    expect(dispatcher.enqueue).not.toHaveBeenCalled();
  });

  it('другая ошибка репозитория пробрасывается', async () => {
    const { service } = build(() => Promise.reject(new Error('БД недоступна')));

    await expect(
      service.dispatch({
        systemKey: 'birthday:2026-08-03',
        channel: MessageChannel.TELEGRAM,
        title: 'С ДР',
        body: 'Поздравляем!',
        recipients: [student()],
      }),
    ).rejects.toThrow('БД недоступна');
  });
});

describe('systemSeedOf', () => {
  it('адрес под канал, персональный текст, статус PENDING', () => {
    const seed = systemSeedOf(
      student(),
      MessageChannel.TELEGRAM,
      'С днём рождения, {{firstName}}!',
    );

    expect(seed.address).toBe('@umed');
    expect(seed.body).toBe('С днём рождения, Умед!');
    expect(seed.status).toBe('PENDING');
    expect(seed.recipientType).toBe('STUDENT');
    expect(seed.studentId).toBe('s1');
    expect(seed.error).toBeNull();
  });

  it('без адреса канала — SKIPPED с причиной', () => {
    const seed = systemSeedOf(
      student({ telegram: null }),
      MessageChannel.TELEGRAM,
      'С днём рождения, {{firstName}}!',
    );

    expect(seed.status).toBe('SKIPPED');
    expect(seed.address).toBe('');
    expect(seed.error).not.toBeNull();
  });

  it('без подстановок персональный текст не хранится (null)', () => {
    const seed = systemSeedOf(student(), MessageChannel.TELEGRAM, 'Общее объявление');

    expect(seed.body).toBeNull();
  });
});
