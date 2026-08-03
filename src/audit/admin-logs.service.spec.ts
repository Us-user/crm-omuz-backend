import { BadRequestException } from '@nestjs/common';
import { AccountType } from '@prisma/client';

import { SortOrder } from '../common';
import { AdminLogsService } from './admin-logs.service';
import { AuditOutcome } from './audit';
import type { AuditLogListParams, AuditLogRow, AuditRepository } from './audit.repository';
import type { AuditLogQueryDto } from './dto';

const row = (over: Partial<AuditLogRow> = {}): AuditLogRow => ({
  id: 'log-1',
  accountId: 'acc-1',
  actorName: 'Фаррух Раҳимов',
  actorPhone: '+992901234567',
  actorType: AccountType.EMPLOYEE,
  action: 'Students.Create',
  method: 'POST',
  path: '/api/v1/students',
  entityId: 'student-1',
  statusCode: 201,
  requestId: 'req-1',
  ip: '10.0.0.1',
  userAgent: 'Mozilla/5.0',
  createdAt: new Date('2026-08-03T09:15:00.000Z'),
  ...over,
});

const query = (over: Partial<AuditLogQueryDto> = {}): AuditLogQueryDto => ({
  page: 1,
  limit: 20,
  order: SortOrder.Desc,
  skip: 0,
  take: 20,
  ...over,
});

describe('AdminLogsService (ТЗ 5.15 «Administration → Logs»)', () => {
  let params: AuditLogListParams | undefined;
  let repository: { findMany: jest.Mock };
  let service: AdminLogsService;

  beforeEach(() => {
    params = undefined;
    repository = {
      findMany: jest.fn((received: AuditLogListParams) => {
        params = received;

        return Promise.resolve({ rows: [row()], total: 1 });
      }),
    };
    service = new AdminLogsService(repository as unknown as AuditRepository);
  });

  it('отдаёт строку журнала с исходом, выведенным из кода ответа', async () => {
    const result = await service.findAll(query());

    expect(result.meta.total).toBe(1);
    expect(result.items[0]).toEqual({
      id: 'log-1',
      actor: {
        accountId: 'acc-1',
        name: 'Фаррух Раҳимов',
        phone: '+992901234567',
        type: AccountType.EMPLOYEE,
      },
      action: 'Students.Create',
      method: 'POST',
      path: '/api/v1/students',
      entityId: 'student-1',
      statusCode: 201,
      outcome: AuditOutcome.Success,
      requestId: 'req-1',
      ip: '10.0.0.1',
      userAgent: 'Mozilla/5.0',
      createdAt: '2026-08-03T09:15:00.000Z',
    });
  });

  it('отказ доступа отдаётся исходом DENIED', async () => {
    repository.findMany.mockResolvedValueOnce({
      rows: [row({ statusCode: 403, entityId: null })],
      total: 1,
    });

    const result = await service.findAll(query());

    expect(result.items[0]?.outcome).toBe(AuditOutcome.Denied);
  });

  it('удалённый аккаунт оставляет снимок имени, а ссылку — пустой', async () => {
    repository.findMany.mockResolvedValueOnce({
      rows: [row({ accountId: null })],
      total: 1,
    });

    const result = await service.findAll(query());

    expect(result.items[0]?.actor).toMatchObject({
      accountId: null,
      name: 'Фаррух Раҳимов',
      phone: '+992901234567',
    });
  });

  it('передаёт фильтры и окно страницы в репозиторий', async () => {
    await service.findAll(
      query({
        page: 2,
        limit: 50,
        skip: 50,
        take: 50,
        search: 'Раҳимов',
        accountId: 'acc-1',
        actorType: AccountType.EMPLOYEE,
        action: 'Students.Delete',
        entityId: 'student-1',
        order: SortOrder.Asc,
      }),
    );

    expect(params).toMatchObject({
      search: 'Раҳимов',
      accountId: 'acc-1',
      actorType: AccountType.EMPLOYEE,
      action: 'Students.Delete',
      entityId: 'student-1',
      order: SortOrder.Asc,
      skip: 50,
      take: 50,
    });
  });

  it('исход переводится в условие по коду ответа', async () => {
    await service.findAll(query({ outcome: AuditOutcome.Success }));
    expect(params?.succeeded).toBe(true);

    await service.findAll(query({ outcome: AuditOutcome.Denied }));
    expect(params?.succeeded).toBe(false);

    await service.findAll(query());
    expect(params?.succeeded).toBeUndefined();
  });

  it('правая граница периода включающая: день целиком входит в выборку', async () => {
    await service.findAll(query({ from: '2026-08-01', to: '2026-08-31' }));

    expect(params?.from?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    // Конец периода уходит в запрос началом следующих суток.
    expect(params?.to?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('несуществующая дата — 400 до запроса в базу', async () => {
    await expect(service.findAll(query({ from: '2026-02-30' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repository.findMany).not.toHaveBeenCalled();
  });

  it('период наоборот — 400', async () => {
    await expect(
      service.findAll(query({ from: '2026-08-31', to: '2026-08-01' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.findMany).not.toHaveBeenCalled();
  });

  it('однодневный период допустим', async () => {
    await expect(
      service.findAll(query({ from: '2026-08-03', to: '2026-08-03' })),
    ).resolves.toBeDefined();
  });

  it('период длиннее года — 400', async () => {
    await expect(
      service.findAll(query({ from: '2025-01-01', to: '2026-08-03' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('одна граница периода ограничения не запускает', async () => {
    await expect(service.findAll(query({ from: '2020-01-01' }))).resolves.toBeDefined();
    expect(params?.to).toBeUndefined();
  });
});
