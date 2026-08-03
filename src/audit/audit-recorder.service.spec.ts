import { AccountType } from '@prisma/client';

import type { AuditEntry } from './audit-recorder.service';
import { AuditRecorder } from './audit-recorder.service';
import type { AuditActor, AuditLogWriteInput, AuditRepository } from './audit.repository';

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  accountId: 'acc-1',
  action: 'Students.Create',
  method: 'POST',
  path: '/api/v1/students',
  entityId: 'student-1',
  statusCode: 201,
  requestId: 'req-1',
  ip: '10.0.0.1',
  userAgent: 'Mozilla/5.0',
  ...over,
});

const actor = (over: Partial<AuditActor> = {}): AuditActor => ({
  phone: '+992901234567',
  type: AccountType.EMPLOYEE,
  firstName: 'Фаррух',
  lastName: 'Раҳимов',
  ...over,
});

describe('AuditRecorder', () => {
  let created: AuditLogWriteInput[];
  let repository: jest.Mocked<Pick<AuditRepository, 'create' | 'findActor'>>;
  let recorder: AuditRecorder;

  beforeEach(() => {
    created = [];
    repository = {
      create: jest.fn(async (input: AuditLogWriteInput) => {
        created.push(input);
        await Promise.resolve();
      }),
      // Снимок находится только у известного аккаунта — как в настоящем запросе.
      findActor: jest.fn((accountId: string) =>
        Promise.resolve<AuditActor | null>(accountId === 'acc-1' ? actor() : null),
      ),
    };
    recorder = new AuditRecorder(repository as unknown as AuditRepository);
  });

  it('пишет действие вместе со снимком о человеке', async () => {
    await recorder.record(entry());

    expect(repository.findActor).toHaveBeenCalledWith('acc-1');
    expect(created[0]).toMatchObject({
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
    });
  });

  it('аккаунт без профиля пишется без имени, а не отбрасывается', async () => {
    repository.findActor.mockResolvedValueOnce(actor({ firstName: null, lastName: null }));

    await recorder.record(entry());

    expect(created[0]?.actorName).toBeNull();
    expect(created[0]?.actorPhone).toBe('+992901234567');
  });

  it('неаутентифицированное действие пишется без действующего лица и без запроса о нём', async () => {
    await recorder.record(entry({ accountId: null, action: 'Auth.PasswordForgot' }));

    expect(repository.findActor).not.toHaveBeenCalled();
    expect(created[0]).toMatchObject({ accountId: null, actorName: null, actorType: null });
  });

  it('действие удалило собственный аккаунт — строка остаётся, ссылка пустая', async () => {
    // Иначе внешний ключ отверг бы вставку, и удаление аккаунта — самое
    // заметное действие в системе — не попало бы в журнал вовсе.
    repository.findActor.mockResolvedValueOnce(null);

    await recorder.record(entry({ action: 'Employees.Delete' }));

    expect(created[0]).toMatchObject({ accountId: null, actorName: null, actorPhone: null });
    expect(created).toHaveLength(1);
  });

  it('сбой записи не бросает наружу — действие уже состоялось', async () => {
    repository.create.mockRejectedValueOnce(new Error('база недоступна'));

    await expect(recorder.record(entry())).resolves.toBeUndefined();
  });

  it('сбой снимка тоже не бросает', async () => {
    repository.findActor.mockRejectedValueOnce(new Error('таймаут'));

    await expect(recorder.record(entry())).resolves.toBeUndefined();
    expect(created).toHaveLength(0);
  });
});
