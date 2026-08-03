import type { ExecutionContext } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccountType } from '@prisma/client';

import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { AuditContextGuard } from './audit-context.guard';
import type { AuditEntry } from './audit-recorder.service';
import { AuditRecorder } from './audit-recorder.service';
import { auditContextOf } from './audit.context';
import { AuditAction } from './decorators/audit-action.decorator';
import { NoAudit } from './decorators/no-audit.decorator';

/**
 * Контроллер-образец: декораторы настоящие, поэтому тест проверяет заодно,
 * что guard читает те самые ключи метаданных, которые они кладут.
 */
class DemoController {
  @RequirePermission('Permission.Students.Create')
  create(): void {}

  @AuditAction('Auth.Login')
  login(): void {}

  @NoAudit()
  refresh(): void {}

  requestAvans(): void {}
}

interface FakeRequest {
  method: string;
  params: Record<string, string>;
  originalUrl: string;
  route?: { path: string };
  ip?: string;
  id?: unknown;
  user?: { accountId: string; sessionId: string; type: AccountType };
  get: (header: string) => string | undefined;
}

/** Ответ, у которого можно объявить отправку и посмотреть, что записалось. */
class FakeResponse {
  statusCode = HttpStatus.OK;
  private readonly listeners: (() => void)[] = [];

  on(event: string, listener: () => void): this {
    if (event === 'finish') this.listeners.push(listener);

    return this;
  }

  /** Ответ ушёл клиенту — с этого момента журнал и пишет строку. */
  finish(statusCode: number): void {
    this.statusCode = statusCode;
    for (const listener of this.listeners) listener();
  }
}

const requestOf = (over: Partial<FakeRequest> = {}): FakeRequest => ({
  method: 'POST',
  params: {},
  originalUrl: '/api/v1/students?search=Иван',
  route: { path: '/api/v1/students' },
  ip: '10.0.0.1',
  id: 'req-1',
  user: { accountId: 'acc-1', sessionId: 'sess-1', type: AccountType.EMPLOYEE },
  get: () => 'Mozilla/5.0',
  ...over,
});

const contextOf = (
  handler: (...args: never[]) => unknown,
  request: FakeRequest,
  response: FakeResponse,
  type: 'http' | 'rpc' = 'http',
): ExecutionContext =>
  ({
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getHandler: () => handler,
    getClass: () => DemoController,
  }) as unknown as ExecutionContext;

describe('AuditContextGuard', () => {
  let recorded: AuditEntry[];
  let guard: AuditContextGuard;
  const demo = new DemoController();

  beforeEach(() => {
    recorded = [];
    const recorder = {
      record: jest.fn((entry: AuditEntry) => {
        recorded.push(entry);

        return Promise.resolve();
      }),
    } as unknown as AuditRecorder;

    guard = new AuditContextGuard(new Reflector(), recorder);
  });

  it('никогда ничего не запрещает', () => {
    const response = new FakeResponse();

    expect(guard.canActivate(contextOf(demo.create, requestOf(), response))).toBe(true);
    expect(guard.canActivate(contextOf(demo.refresh, requestOf(), response))).toBe(true);
    expect(guard.canActivate(contextOf(demo.create, requestOf({ method: 'GET' }), response))).toBe(
      true,
    );
  });

  it('пишет успешное действие: кто, что, над чем и с каким кодом ответа', () => {
    const request = requestOf();
    const response = new FakeResponse();

    guard.canActivate(contextOf(demo.create, request, response));
    // Идентификатор созданной записи кладёт перехватчик — здесь он подставлен
    // прямо в заготовку, чтобы проверить именно сборку строки.
    const stash = auditContextOf(request);
    if (stash) stash.entityId = 'student-1';
    response.finish(HttpStatus.CREATED);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      accountId: 'acc-1',
      // Имя действия выведено из права эндпоинта — второго перечня действий нет.
      action: 'Students.Create',
      method: 'POST',
      path: '/api/v1/students',
      entityId: 'student-1',
      statusCode: HttpStatus.CREATED,
      requestId: 'req-1',
      ip: '10.0.0.1',
      userAgent: 'Mozilla/5.0',
    });
  });

  it('чтение в журнал не пишется и заготовки не заводит', () => {
    const request = requestOf({ method: 'GET' });
    const response = new FakeResponse();

    guard.canActivate(contextOf(demo.create, request, response));
    response.finish(HttpStatus.OK);

    expect(auditContextOf(request)).toBeUndefined();
    expect(recorded).toHaveLength(0);
  });

  it('@NoAudit исключает изменяющий запрос', () => {
    const response = new FakeResponse();

    guard.canActivate(contextOf(demo.refresh, requestOf(), response));
    response.finish(HttpStatus.OK);

    expect(recorded).toHaveLength(0);
  });

  it('не-HTTP вызов журналу не адресуется', () => {
    const response = new FakeResponse();

    guard.canActivate(contextOf(demo.create, requestOf(), response, 'rpc'));
    response.finish(HttpStatus.CREATED);

    expect(recorded).toHaveLength(0);
  });

  it('отказ в правах пишется — ради этого журнал и живёт в guard, а не в перехватчике', () => {
    const response = new FakeResponse();

    guard.canActivate(contextOf(demo.create, requestOf(), response));
    response.finish(HttpStatus.FORBIDDEN);

    expect(recorded[0]).toMatchObject({
      action: 'Students.Create',
      statusCode: HttpStatus.FORBIDDEN,
      entityId: null,
    });
  });

  it('запрос без токена виден строкой без действующего лица', () => {
    const response = new FakeResponse();

    guard.canActivate(contextOf(demo.create, requestOf({ user: undefined }), response));
    response.finish(HttpStatus.UNAUTHORIZED);

    expect(recorded[0]).toMatchObject({ accountId: null, statusCode: HttpStatus.UNAUTHORIZED });
  });

  it('ошибка формы и ошибка сервера в журнал не идут', () => {
    const first = new FakeResponse();
    guard.canActivate(contextOf(demo.create, requestOf(), first));
    first.finish(HttpStatus.UNPROCESSABLE_ENTITY);

    const second = new FakeResponse();
    guard.canActivate(contextOf(demo.create, requestOf(), second));
    second.finish(HttpStatus.INTERNAL_SERVER_ERROR);

    expect(recorded).toHaveLength(0);
  });

  it('@AuditAction перекрывает и право, и имя обработчика', () => {
    const response = new FakeResponse();
    const request = requestOf({ user: undefined });

    guard.canActivate(contextOf(demo.login, request, response));
    const stash = auditContextOf(request);
    // «Кто» у входа приходит из ответа обработчика — его кладёт перехватчик.
    if (stash) stash.actorId = 'acc-9';
    response.finish(HttpStatus.OK);

    expect(recorded[0]).toMatchObject({ action: 'Auth.Login', accountId: 'acc-9' });
  });

  it('без права и без декоратора имя выводится из класса и обработчика', () => {
    const response = new FakeResponse();

    guard.canActivate(contextOf(demo.requestAvans, requestOf(), response));
    response.finish(HttpStatus.CREATED);

    expect(recorded[0]?.action).toBe('Demo.requestAvans');
  });

  it('идентификатор из пути важнее идентификатора созданной записи', () => {
    const request = requestOf({
      params: { id: 'group-1' },
      route: { path: '/api/v1/groups/:id/students' },
    });
    const response = new FakeResponse();

    guard.canActivate(contextOf(demo.create, request, response));
    const stash = auditContextOf(request);
    if (stash) stash.entityId = 'membership-1';
    response.finish(HttpStatus.CREATED);

    expect(recorded[0]).toMatchObject({
      entityId: 'group-1',
      path: '/api/v1/groups/:id/students',
    });
  });

  it('без шаблона маршрута берётся адрес без строки запроса', () => {
    const response = new FakeResponse();

    guard.canActivate(contextOf(demo.create, requestOf({ route: undefined }), response));
    response.finish(HttpStatus.CREATED);

    // Строка поиска содержит персональные данные и в журнал попасть не должна.
    expect(recorded[0]?.path).toBe('/api/v1/students');
  });
});
