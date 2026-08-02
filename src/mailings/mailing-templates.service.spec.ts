import { ConflictException, NotFoundException } from '@nestjs/common';
import { DirectoryStatus, MessageChannel } from '@prisma/client';

import { SortOrder } from '../common';
import { TemplateSortField } from './dto';
import { MailingTemplatesService } from './mailing-templates.service';
import type { MailingsRepository, TemplateRow } from './mailings.repository';

const row = (over: Partial<TemplateRow> = {}): TemplateRow => ({
  id: 't1',
  name: 'Напоминание об оплате',
  title: 'Оплата обучения',
  body: 'Внесите оплату до 5 числа.',
  channel: null,
  status: DirectoryStatus.ACTIVE,
  createdAt: new Date('2026-08-01T10:00:00.000Z'),
  updatedAt: new Date('2026-08-02T10:00:00.000Z'),
  createdBy: null,
  _count: { mailings: 0 },
  ...over,
});

interface Repo {
  findTemplates: jest.Mock;
  findTemplateById: jest.Mock;
  findTemplateByName: jest.Mock;
  createTemplate: jest.Mock;
  updateTemplate: jest.Mock;
  deleteTemplate: jest.Mock;
  findEmployeeByAccount: jest.Mock;
}

const build = (): { service: MailingTemplatesService; repo: Repo } => {
  const repo: Repo = {
    findTemplates: jest.fn().mockResolvedValue({ rows: [row()], total: 1 }),
    findTemplateById: jest.fn().mockResolvedValue(row()),
    findTemplateByName: jest.fn().mockResolvedValue(null),
    createTemplate: jest
      .fn()
      .mockImplementation((input: Record<string, unknown>) =>
        Promise.resolve(row(input as Partial<TemplateRow>)),
      ),
    updateTemplate: jest.fn().mockResolvedValue(row({ name: 'Новое имя' })),
    deleteTemplate: jest.fn().mockResolvedValue(undefined),
    findEmployeeByAccount: jest.fn().mockResolvedValue({ id: 'e1' }),
  };

  return {
    service: new MailingTemplatesService(repo as unknown as MailingsRepository),
    repo,
  };
};

const query = {
  page: 1,
  limit: 20,
  skip: 0,
  take: 20,
  sort: TemplateSortField.Name,
  order: SortOrder.Asc,
};

describe('MailingTemplatesService', () => {
  it('отдаёт постраничный список с числом составленных рассылок', async () => {
    const { service } = build();

    const result = await service.findAll(query);

    expect(result.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
    expect(result.items[0]).toMatchObject({
      id: 't1',
      name: 'Напоминание об оплате',
      channel: null,
      mailingsCount: 0,
    });
  });

  it('передаёт фильтры и сортировку в выборку как есть', async () => {
    const { service, repo } = build();

    await service.findAll({
      ...query,
      search: 'оплат',
      status: DirectoryStatus.INACTIVE,
      channel: MessageChannel.SMS,
    });

    expect(repo.findTemplates).toHaveBeenCalledWith(
      expect.objectContaining({
        search: 'оплат',
        status: DirectoryStatus.INACTIVE,
        channel: MessageChannel.SMS,
        skip: 0,
        take: 20,
      }),
    );
  });

  it('несуществующий шаблон — 404', async () => {
    const { service, repo } = build();
    repo.findTemplateById.mockResolvedValue(null);

    await expect(service.findOne('t1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('создаёт шаблон и подписывает его сотрудником из токена', async () => {
    const { service, repo } = build();

    await service.create({ name: 'Новый', title: 'Заголовок', body: 'Текст' }, 'acc-1');

    expect(repo.createTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Новый', channel: null, createdById: 'e1' }),
    );
  });

  it('аккаунт без карточки сотрудника заводит шаблон без подписи, а не получает отказ', async () => {
    const { service, repo } = build();
    repo.findEmployeeByAccount.mockResolvedValue(null);

    await service.create({ name: 'Новый', title: 'З', body: 'Т' }, 'acc-1');

    expect(repo.createTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ createdById: null }),
    );
  });

  it('тёзка без учёта регистра — 409', async () => {
    const { service, repo } = build();
    repo.findTemplateByName.mockResolvedValue({ id: 'other', name: 'Напоминание' });

    await expect(
      service.create({ name: 'напоминание', title: 'З', body: 'Т' }, 'acc-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('сам себе тёзкой не считается: правка с прежним именем проходит', async () => {
    const { service, repo } = build();
    repo.findTemplateByName.mockResolvedValue({ id: 't1', name: 'Напоминание об оплате' });

    await expect(service.update('t1', { name: 'Напоминание об оплате' })).resolves.toMatchObject({
      id: 't1',
    });
  });

  it('не переданное поле в правку не уходит, а `null` в канале снимает привязку', async () => {
    const { service, repo } = build();

    await service.update('t1', { channel: null });

    expect(repo.updateTemplate).toHaveBeenCalledWith('t1', {
      name: undefined,
      title: undefined,
      body: undefined,
      channel: null,
      status: undefined,
    });
  });

  it('использованный шаблон удаляется: рассылка хранит текст снимком', async () => {
    const { service, repo } = build();
    repo.findTemplateById.mockResolvedValue(row({ _count: { mailings: 7 } }));

    await expect(service.remove('t1')).resolves.toEqual({
      id: 't1',
      name: 'Напоминание об оплате',
    });
    expect(repo.deleteTemplate).toHaveBeenCalledWith('t1');
  });

  it('удаление несуществующего — 404 до обращения к БД', async () => {
    const { service, repo } = build();
    repo.findTemplateById.mockResolvedValue(null);

    await expect(service.remove('t1')).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.deleteTemplate).not.toHaveBeenCalled();
  });
});
