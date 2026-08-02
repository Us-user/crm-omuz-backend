import { NotFoundException } from '@nestjs/common';
import { MailingAudience, MessageChannel, NotificationStatus } from '@prisma/client';

import { BusinessRuleException, SortOrder } from '../common';
import { MailingSortField } from './dto';
import type { MailingDispatcher } from './mailing-dispatcher';
import { MailingStatus } from './mailings';
import type { MailingRow, MailingsRepository, RecipientRow } from './mailings.repository';
import { MailingsService, NO_ADDRESS_REASON } from './mailings.service';

const mailing = (over: Partial<MailingRow> = {}): MailingRow => ({
  id: 'm1',
  title: 'Занятия',
  body: 'Перенос на 14:00',
  channel: MessageChannel.TELEGRAM,
  audience: MailingAudience.STUDENTS,
  sentAt: null,
  createdAt: new Date('2026-08-01T10:00:00.000Z'),
  updatedAt: new Date('2026-08-01T10:00:00.000Z'),
  group: null,
  template: null,
  createdBy: null,
  sentBy: null,
  ...over,
});

const person = (over: Partial<RecipientRow> = {}): RecipientRow => ({
  id: 's1',
  firstName: 'Умед',
  lastName: 'Раҳимов',
  telegram: '@umed',
  phone: '+992900000001',
  email: 'umed@omuz.tj',
  ...over,
});

interface Repo {
  findMailings: jest.Mock;
  findMailingById: jest.Mock;
  createMailing: jest.Mock;
  updateMailing: jest.Mock;
  deleteMailing: jest.Mock;
  markSent: jest.Mock;
  findGroup: jest.Mock;
  findTemplateById: jest.Mock;
  countDeliveriesByMailing: jest.Mock;
  findNotifications: jest.Mock;
  findRetryableDeliveryIds: jest.Mock;
  resetDeliveries: jest.Mock;
  findGroupStudents: jest.Mock;
  findActiveStudents: jest.Mock;
  findMentors: jest.Mock;
  findLeads: jest.Mock;
  findGraduates: jest.Mock;
  findEmployeeByAccount: jest.Mock;
}

const build = (): { service: MailingsService; repo: Repo; enqueue: jest.Mock } => {
  const repo: Repo = {
    findMailings: jest.fn().mockResolvedValue({ rows: [mailing()], total: 1 }),
    findMailingById: jest.fn().mockResolvedValue(mailing()),
    createMailing: jest
      .fn()
      .mockImplementation((input: Record<string, unknown>) =>
        Promise.resolve(mailing(input as Partial<MailingRow>)),
      ),
    updateMailing: jest.fn().mockResolvedValue(mailing({ title: 'Новый заголовок' })),
    deleteMailing: jest.fn().mockResolvedValue(undefined),
    markSent: jest
      .fn()
      .mockImplementation((params: { sentAt: Date }) =>
        Promise.resolve(mailing({ sentAt: params.sentAt })),
      ),
    findGroup: jest.fn().mockResolvedValue({ id: 'g1', name: 'Frontend-1' }),
    findTemplateById: jest.fn().mockResolvedValue({
      id: 't1',
      title: 'Из шаблона',
      body: 'Текст шаблона',
    }),
    countDeliveriesByMailing: jest.fn().mockResolvedValue([]),
    findNotifications: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
    findRetryableDeliveryIds: jest.fn().mockResolvedValue([]),
    resetDeliveries: jest.fn().mockResolvedValue(undefined),
    findGroupStudents: jest.fn().mockResolvedValue([person()]),
    findActiveStudents: jest.fn().mockResolvedValue([person()]),
    findMentors: jest.fn().mockResolvedValue([person({ id: 'e1' })]),
    findLeads: jest.fn().mockResolvedValue([person({ id: 'l1' })]),
    findGraduates: jest.fn().mockResolvedValue([person({ id: 's9' })]),
    findEmployeeByAccount: jest.fn().mockResolvedValue({ id: 'emp-1' }),
  };

  const enqueue = jest.fn().mockResolvedValue(undefined);
  const dispatcher = { enqueue } as unknown as MailingDispatcher;

  return {
    service: new MailingsService(repo as unknown as MailingsRepository, dispatcher),
    repo,
    enqueue,
  };
};

const query = {
  page: 1,
  limit: 20,
  skip: 0,
  take: 20,
  sort: MailingSortField.CreatedAt,
  order: SortOrder.Desc,
};

describe('MailingsService — список и карточка', () => {
  it('черновик отдаётся с нулевыми счётчиками и состоянием DRAFT', async () => {
    const { service } = build();

    const result = await service.findAll(query);

    expect(result.items[0]).toMatchObject({
      id: 'm1',
      status: MailingStatus.DRAFT,
      deliveries: { total: 0, pending: 0, sent: 0, failed: 0, skipped: 0 },
      sentAt: null,
    });
  });

  it('счётчики страницы берутся одним запросом на все строки', async () => {
    const { service, repo } = build();
    repo.findMailings.mockResolvedValue({
      rows: [mailing({ id: 'm1' }), mailing({ id: 'm2' })],
      total: 2,
    });
    repo.countDeliveriesByMailing.mockResolvedValue([
      { mailingId: 'm1', status: NotificationStatus.SENT, count: 3 },
      { mailingId: 'm2', status: NotificationStatus.FAILED, count: 1 },
    ]);

    await service.findAll(query);

    expect(repo.countDeliveriesByMailing).toHaveBeenCalledTimes(1);
    expect(repo.countDeliveriesByMailing).toHaveBeenCalledWith(['m1', 'm2']);
  });

  it('состояние выводится из счётчиков: часть не дошла — PARTIAL', async () => {
    const { service, repo } = build();
    repo.findMailingById.mockResolvedValue(mailing({ sentAt: new Date('2026-08-02T09:00:00Z') }));
    repo.countDeliveriesByMailing.mockResolvedValue([
      { mailingId: 'm1', status: NotificationStatus.SENT, count: 5 },
      { mailingId: 'm1', status: NotificationStatus.FAILED, count: 2 },
    ]);

    await expect(service.findOne('m1')).resolves.toMatchObject({
      status: MailingStatus.PARTIAL,
      deliveries: { total: 7, sent: 5, failed: 2 },
    });
  });

  it('история спрашивает только отправленные, что бы ни стояло в фильтре', async () => {
    const { service, repo } = build();

    await service.findHistory({ ...query, sent: false });

    expect(repo.findMailings).toHaveBeenCalledWith(expect.objectContaining({ sent: true }));
  });

  it('в списке фильтр `sent` передаётся как есть', async () => {
    const { service, repo } = build();

    await service.findAll({ ...query, sent: false });

    expect(repo.findMailings).toHaveBeenCalledWith(expect.objectContaining({ sent: false }));
  });

  it('несуществующая рассылка — 404', async () => {
    const { service, repo } = build();
    repo.findMailingById.mockResolvedValue(null);

    await expect(service.findOne('m1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MailingsService — составление', () => {
  it('без шаблона требует и заголовок, и текст', async () => {
    const { service } = build();

    await expect(
      service.create(
        { channel: MessageChannel.SMS, audience: MailingAudience.STUDENTS, title: 'Есть' },
        'acc-1',
      ),
    ).rejects.toBeInstanceOf(BusinessRuleException);
  });

  it('шаблон подставляет заголовок и текст снимком', async () => {
    const { service, repo } = build();

    await service.create(
      {
        channel: MessageChannel.SMS,
        audience: MailingAudience.STUDENTS,
        templateId: 't1',
      },
      'acc-1',
    );

    expect(repo.createMailing).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Из шаблона', body: 'Текст шаблона', templateId: 't1' }),
    );
  });

  it('явно переданный текст перекрывает шаблон', async () => {
    const { service, repo } = build();

    await service.create(
      {
        channel: MessageChannel.SMS,
        audience: MailingAudience.STUDENTS,
        templateId: 't1',
        body: 'Свой текст',
      },
      'acc-1',
    );

    expect(repo.createMailing).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Из шаблона', body: 'Свой текст' }),
    );
  });

  it('несуществующий шаблон — 422, а не 404: ресурс из пути найден', async () => {
    const { service, repo } = build();
    repo.findTemplateById.mockResolvedValue(null);

    await expect(
      service.create(
        {
          channel: MessageChannel.SMS,
          audience: MailingAudience.STUDENTS,
          templateId: 't1',
        },
        'acc-1',
      ),
    ).rejects.toBeInstanceOf(BusinessRuleException);
  });

  it('аудитория GROUP без группы — 422', async () => {
    const { service } = build();

    await expect(
      service.create(
        {
          channel: MessageChannel.SMS,
          audience: MailingAudience.GROUP,
          title: 'З',
          body: 'Т',
        },
        'acc-1',
      ),
    ).rejects.toBeInstanceOf(BusinessRuleException);
  });

  it('группа у аудитории «все студенты» — тоже 422: это отбор, которого не будет', async () => {
    const { service } = build();

    await expect(
      service.create(
        {
          channel: MessageChannel.SMS,
          audience: MailingAudience.STUDENTS,
          title: 'З',
          body: 'Т',
          groupId: 'g1',
        },
        'acc-1',
      ),
    ).rejects.toBeInstanceOf(BusinessRuleException);
  });

  it('несуществующая группа — 422', async () => {
    const { service, repo } = build();
    repo.findGroup.mockResolvedValue(null);

    await expect(
      service.create(
        {
          channel: MessageChannel.SMS,
          audience: MailingAudience.GROUP,
          title: 'З',
          body: 'Т',
          groupId: 'g1',
        },
        'acc-1',
      ),
    ).rejects.toBeInstanceOf(BusinessRuleException);
  });
});

describe('MailingsService — правка и удаление', () => {
  it('отправленную не правит', async () => {
    const { service, repo } = build();
    repo.findMailingById.mockResolvedValue(mailing({ sentAt: new Date() }));

    await expect(service.update('m1', { title: 'Другое' })).rejects.toBeInstanceOf(
      BusinessRuleException,
    );
    expect(repo.updateMailing).not.toHaveBeenCalled();
  });

  it('без смены аудитории и группы группу не трогает', async () => {
    const { service, repo } = build();

    await service.update('m1', { title: 'Другое' });

    expect(repo.updateMailing).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ groupId: undefined }),
    );
    expect(repo.findGroup).not.toHaveBeenCalled();
  });

  it('смена аудитории на GROUP без группы — 422 по итоговому состоянию', async () => {
    const { service } = build();

    await expect(service.update('m1', { audience: MailingAudience.GROUP })).rejects.toBeInstanceOf(
      BusinessRuleException,
    );
  });

  it('удаляет черновик', async () => {
    const { service, repo } = build();

    await expect(service.remove('m1')).resolves.toEqual({ id: 'm1', title: 'Занятия' });
    expect(repo.deleteMailing).toHaveBeenCalledWith('m1');
  });

  it('отправленную не удаляет: это история того, что центр написал людям', async () => {
    const { service, repo } = build();
    repo.findMailingById.mockResolvedValue(mailing({ sentAt: new Date() }));

    await expect(service.remove('m1')).rejects.toBeInstanceOf(BusinessRuleException);
    expect(repo.deleteMailing).not.toHaveBeenCalled();
  });
});

describe('MailingsService — отправка', () => {
  it('заводит строку доставки на каждого получателя и ставит задачи в очередь', async () => {
    const { service, repo, enqueue } = build();
    repo.findActiveStudents.mockResolvedValue([person({ id: 's1' }), person({ id: 's2' })]);

    const result = await service.send('m1', 'acc-1');

    expect(result.deliveries).toMatchObject({ total: 2, pending: 2, skipped: 0 });
    expect(result.queued).toBe(2);
    expect(enqueue).toHaveBeenCalledWith(expect.arrayContaining([expect.any(String)]));
    expect((enqueue.mock.calls[0] as string[][])[0]).toHaveLength(2);
  });

  it('получатель без адреса канала попадает в рассылку строкой SKIPPED, а не выпадает', async () => {
    const { service, repo, enqueue } = build();
    repo.findActiveStudents.mockResolvedValue([
      person({ id: 's1' }),
      person({ id: 's2', telegram: null }),
    ]);

    const result = await service.send('m1', 'acc-1');

    expect(result.deliveries).toMatchObject({ total: 2, pending: 1, skipped: 1 });
    // Задача очереди для него была бы задачей, которая гарантированно упадёт.
    expect(result.queued).toBe(1);
    expect((enqueue.mock.calls[0] as string[][])[0]).toHaveLength(1);

    const seeds = (
      repo.markSent.mock.calls[0] as { notifications: { error: string | null }[] }[]
    )[0].notifications;
    expect(seeds.find((seed) => seed.error !== null)?.error).toBe(NO_ADDRESS_REASON);
  });

  it('канал определяет, какой контакт становится адресом', async () => {
    const { service, repo } = build();
    repo.findMailingById.mockResolvedValue(mailing({ channel: MessageChannel.SMS }));

    await service.send('m1', 'acc-1');

    const seeds = (repo.markSent.mock.calls[0] as { notifications: { address: string }[] }[])[0]
      .notifications;
    expect(seeds[0]?.address).toBe('+992900000001');
  });

  it('вид получателя следует из аудитории: ментору пишут как сотруднику', async () => {
    const { service, repo } = build();
    repo.findMailingById.mockResolvedValue(mailing({ audience: MailingAudience.MENTORS }));

    await service.send('m1', 'acc-1');

    const seeds = (
      repo.markSent.mock.calls[0] as {
        notifications: { recipientType: string; employeeId: string | null }[];
      }[]
    )[0].notifications;
    expect(seeds[0]).toMatchObject({ recipientType: 'EMPLOYEE', employeeId: 'e1' });
  });

  it('лид адресуется как обращение', async () => {
    const { service, repo } = build();
    repo.findMailingById.mockResolvedValue(mailing({ audience: MailingAudience.LEADS }));

    await service.send('m1', 'acc-1');

    const seeds = (
      repo.markSent.mock.calls[0] as {
        notifications: { recipientType: string; leadId: string | null }[];
      }[]
    )[0].notifications;
    expect(seeds[0]).toMatchObject({ recipientType: 'LEAD', leadId: 'l1' });
  });

  it('аудитория GROUP спрашивает состав своей группы', async () => {
    const { service, repo } = build();
    repo.findMailingById.mockResolvedValue(
      mailing({ audience: MailingAudience.GROUP, group: { id: 'g1', name: 'Frontend-1' } }),
    );

    await service.send('m1', 'acc-1');

    expect(repo.findGroupStudents).toHaveBeenCalledWith('g1');
    expect(repo.findActiveStudents).not.toHaveBeenCalled();
  });

  it('аудитория GRADUATES спрашивает выпускников', async () => {
    const { service, repo } = build();
    repo.findMailingById.mockResolvedValue(mailing({ audience: MailingAudience.GRADUATES }));

    await service.send('m1', 'acc-1');

    expect(repo.findGraduates).toHaveBeenCalled();
  });

  it('пустая аудитория — 422 до записи строк', async () => {
    const { service, repo, enqueue } = build();
    repo.findActiveStudents.mockResolvedValue([]);

    await expect(service.send('m1', 'acc-1')).rejects.toBeInstanceOf(BusinessRuleException);
    expect(repo.markSent).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('аудитория сверх потолка — 422, а не усечение', async () => {
    const { service, repo } = build();
    repo.findActiveStudents.mockResolvedValue(
      Array.from({ length: 5001 }, (_, index) => person({ id: `s${String(index)}` })),
    );

    await expect(service.send('m1', 'acc-1')).rejects.toBeInstanceOf(BusinessRuleException);
    expect(repo.markSent).not.toHaveBeenCalled();
  });

  it('ровно потолок проходит', async () => {
    const { service, repo } = build();
    repo.findActiveStudents.mockResolvedValue(
      Array.from({ length: 5000 }, (_, index) => person({ id: `s${String(index)}` })),
    );

    await expect(service.send('m1', 'acc-1')).resolves.toMatchObject({ queued: 5000 });
  });

  it('повторная отправка — 422: отменить второе сообщение было бы нечем', async () => {
    const { service, repo, enqueue } = build();
    repo.findMailingById.mockResolvedValue(mailing({ sentAt: new Date() }));

    await expect(service.send('m1', 'acc-1')).rejects.toBeInstanceOf(BusinessRuleException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('задачи ставятся после записи строк, а не до неё', async () => {
    const { service, repo, enqueue } = build();
    const order: string[] = [];
    repo.markSent.mockImplementation((params: { sentAt: Date }) => {
      order.push('markSent');

      return Promise.resolve(mailing({ sentAt: params.sentAt }));
    });
    enqueue.mockImplementation(() => {
      order.push('enqueue');

      return Promise.resolve();
    });

    await service.send('m1', 'acc-1');

    expect(order).toEqual(['markSent', 'enqueue']);
  });

  it('отправитель — сотрудник за токеном', async () => {
    const { service, repo } = build();

    await service.send('m1', 'acc-1');

    expect(repo.markSent).toHaveBeenCalledWith(expect.objectContaining({ sentById: 'emp-1' }));
  });
});

describe('MailingsService — повтор незавершённых', () => {
  it('возвращает в очередь то, что отдал репозиторий, и сбрасывает эти же строки', async () => {
    const { service, repo, enqueue } = build();
    repo.findMailingById.mockResolvedValue(mailing({ sentAt: new Date() }));
    repo.findRetryableDeliveryIds.mockResolvedValue(['n1', 'n2']);

    const result = await service.retry('m1');

    expect(repo.resetDeliveries).toHaveBeenCalledWith(['n1', 'n2']);
    expect(enqueue).toHaveBeenCalledWith(['n1', 'n2']);
    expect(result.queued).toBe(2);
  });

  it('неотправленную повторять нечего — 422', async () => {
    const { service, repo } = build();

    await expect(service.retry('m1')).rejects.toBeInstanceOf(BusinessRuleException);
    expect(repo.findRetryableDeliveryIds).not.toHaveBeenCalled();
  });

  it('когда повторять нечего — проходит и ставит ноль задач', async () => {
    const { service, repo } = build();
    repo.findMailingById.mockResolvedValue(mailing({ sentAt: new Date() }));

    await expect(service.retry('m1')).resolves.toMatchObject({ queued: 0 });
  });
});

describe('MailingsService — доставки', () => {
  it('отдаёт счётчики всей рассылки в meta рядом со страницей', async () => {
    const { service, repo } = build();
    repo.countDeliveriesByMailing.mockResolvedValue([
      { mailingId: 'm1', status: NotificationStatus.SENT, count: 4 },
      { mailingId: 'm1', status: NotificationStatus.SKIPPED, count: 1 },
    ]);

    const result = await service.findRecipients('m1', query);

    expect(result.meta).toMatchObject({
      deliveries: { total: 5, sent: 4, skipped: 1 },
    });
  });

  it('фильтр по состоянию доставки уходит в выборку', async () => {
    const { service, repo } = build();

    await service.findRecipients('m1', {
      ...query,
      status: NotificationStatus.FAILED,
    });

    expect(repo.findNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ mailingId: 'm1', status: NotificationStatus.FAILED }),
    );
  });

  it('доставки несуществующей рассылки — 404 до выборки', async () => {
    const { service, repo } = build();
    repo.findMailingById.mockResolvedValue(null);

    await expect(service.findRecipients('m1', query as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.findNotifications).not.toHaveBeenCalled();
  });
});
