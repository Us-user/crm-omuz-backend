import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';

import { AuditInterceptor } from './audit.interceptor';
import type { AuditContext } from './audit.context';
import { auditContextOf, setAuditContext } from './audit.context';

const contextOf = (request: object, type: 'http' | 'rpc' = 'http'): ExecutionContext =>
  ({
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

const handlerOf = (payload: unknown): CallHandler<unknown> => ({ handle: () => of(payload) });

const stashed = (request: object): AuditContext => {
  const stash = auditContextOf(request);
  if (!stash) throw new Error('заготовки нет');

  return stash;
};

describe('AuditInterceptor', () => {
  const interceptor = new AuditInterceptor();

  it('кладёт в заготовку идентификатор созданной записи', async () => {
    const request = {};
    setAuditContext(request, { action: 'Students.Create', entityId: null, actorId: null });

    await lastValueFrom(
      interceptor.intercept(contextOf(request), handlerOf({ id: 'student-1', firstName: 'Аниса' })),
    );

    expect(stashed(request).entityId).toBe('student-1');
  });

  it('разворачивает обёртку `{ data }`, кто бы из перехватчиков ни был снаружи', async () => {
    const request = {};
    setAuditContext(request, { action: 'Students.Create', entityId: null, actorId: null });

    await lastValueFrom(
      interceptor.intercept(contextOf(request), handlerOf({ data: { id: 'student-1' } })),
    );

    expect(stashed(request).entityId).toBe('student-1');
  });

  it('у входа кладёт аккаунт действующего лица', async () => {
    const request = {};
    setAuditContext(request, { action: 'Auth.Login', entityId: null, actorId: null });

    await lastValueFrom(
      interceptor.intercept(
        contextOf(request),
        handlerOf({ account: { id: 'acc-9' }, tokens: { accessToken: 'x' } }),
      ),
    );

    expect(stashed(request).actorId).toBe('acc-9');
    // Аккаунт — это «кто», а не «над чем»: объектом действия он не становится.
    expect(stashed(request).entityId).toBeNull();
  });

  it('ответ обработчика доходит до клиента как есть', async () => {
    const request = {};
    setAuditContext(request, { action: 'Students.Create', entityId: null, actorId: null });
    const payload = { id: 'student-1' };

    const result = await lastValueFrom(
      interceptor.intercept(contextOf(request), handlerOf(payload)),
    );

    expect(result).toBe(payload);
  });

  it('без заготовки не делает ничего: запрос журналу не адресуется', async () => {
    const request = {};

    const result = await lastValueFrom(
      interceptor.intercept(contextOf(request), handlerOf({ id: 'x' })),
    );

    expect(result).toEqual({ id: 'x' });
    expect(auditContextOf(request)).toBeUndefined();
  });

  it('не-HTTP вызов пропускается без разбора запроса', async () => {
    const result = await lastValueFrom(
      interceptor.intercept(contextOf({}, 'rpc'), handlerOf({ id: 'x' })),
    );

    expect(result).toEqual({ id: 'x' });
  });
});
