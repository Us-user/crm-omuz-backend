import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

import type { AuthenticatedUser } from '../auth';
import { PERMISSIONS_KEY } from '../rbac/rbac.constants';
import {
  actionFromPermission,
  entityIdFromParams,
  fallbackAction,
  isAuditableMethod,
  isRecordableStatus,
  truncate,
} from './audit';
import { AuditRecorder } from './audit-recorder.service';
import { auditContextOf, setAuditContext } from './audit.context';
import { AUDIT_ACTION_KEY } from './decorators/audit-action.decorator';
import { NO_AUDIT_KEY } from './decorators/no-audit.decorator';

/** Запрос в том виде, в каком его читает журнал. */
type AuditableRequest = Request & {
  user?: AuthenticatedUser;
  /** Пишется логгером Pino (0001) — та же метка, что в логах и в теле ошибки. */
  id?: unknown;
};

/**
 * Журнал действий (ТЗ 3.6): кто, что, когда — автоматически, на каждом
 * изменяющем запросе.
 *
 * **Почему guard, а не перехватчик.** Перехватчик выглядел естественнее —
 * и не годится: guard'ы Nest отрабатывают **до** него, поэтому отказ в правах
 * (403) и запрос без токена (401) до перехватчика не доходят вовсе, а это
 * ровно половина того, ради чего аудит ведут (ТЗ 3.8). Guard — последнее место
 * цикла, где ещё видны метаданные обработчика **и** ещё не принято решение
 * об отказе. Он ничего не запрещает: всегда возвращает `true`, а его работа —
 * подписаться на отправку ответа.
 *
 * **Почему запись на `finish`.** Так строка получает настоящий код ответа
 * (Nest применяет `@HttpCode` уже после перехватчиков), и путь записи один
 * на все исходы. Цена названа прямо: если соединение оборвалось и ответ
 * не ушёл, строки не будет.
 *
 * **Почему автоматически, а не вызовом из каждого сервиса.** Аудит обязан
 * покрывать все действия, а вызов, который надо не забыть добавить, рано или
 * поздно забывают — и потеря происходит молча. Тот же довод, по которому
 * `@RequirePermission` сам навешивает guard (0005). Обратная сторона названа
 * честно: журнал знает про HTTP-запрос, а не про предметную операцию, поэтому
 * действия системы (поздравления с ДР, автозакрытие месяца — 0037) в него
 * не попадают: их никто не запрашивал.
 */
@Injectable()
export class AuditContextGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly recorder: AuditRecorder,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Задачи очереди и прочие не-HTTP вызовы журналу не адресуются.
    if (context.getType() !== 'http') return true;

    const http = context.switchToHttp();
    const request = http.getRequest<AuditableRequest>();

    if (!isAuditableMethod(request.method) || this.skipped(context)) return true;

    setAuditContext(request, { action: this.actionOf(context), entityId: null, actorId: null });

    const response = http.getResponse<Response>();
    response.on('finish', () => {
      this.write(request, response);
    });

    return true;
  }

  /**
   * Имя действия. Сначала явное (`@AuditAction`), затем — первое право
   * эндпоинта без префикса `Permission.`: эндпоинт уже объявил, чем является,
   * и второй перечень действий разошёлся бы с правами. Последним — имя класса
   * и обработчика, чтобы действие не осталось безымянным никогда.
   */
  private actionOf(context: ExecutionContext): string {
    const explicit = this.reflector.getAllAndOverride<string | undefined>(AUDIT_ACTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (explicit !== undefined) return explicit;

    const codes = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const code = codes?.[0];
    if (code !== undefined) return actionFromPermission(code);

    return fallbackAction(context.getClass().name, context.getHandler().name);
  }

  private skipped(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean | undefined>(NO_AUDIT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  private write(request: AuditableRequest, response: Response): void {
    const stash = auditContextOf(request);
    // Заготовка кладётся прямо перед подпиской, поэтому её отсутствие
    // означало бы, что подписался кто-то другой.
    if (stash === undefined || !isRecordableStatus(response.statusCode)) return;

    // Запись не ждут — ответ уже ушёл; `record` не бросает (см. `AuditRecorder`).
    void this.recorder.record({
      // Токена нет только у входа и регистрации (ТЗ 5.1) — там «кто»
      // кладёт в заготовку перехватчик, разобрав карточку аккаунта из ответа.
      accountId: request.user?.accountId ?? stash.actorId,
      action: stash.action,
      method: request.method.toUpperCase(),
      // Шаблон маршрута, а не адрес: в адресе стоят подставленные значения
      // и строка поиска, то есть персональные данные.
      path: pathOf(request),
      // Объект из пути важнее созданного: `POST /groups/:id/students` — это
      // действие над группой, а не над строкой состава.
      entityId: entityIdFromParams(request.params) ?? stash.entityId,
      statusCode: response.statusCode,
      requestId: typeof request.id === 'string' ? request.id : null,
      ip: truncate(request.ip),
      userAgent: truncate(request.get('user-agent')),
    });
  }
}

/**
 * `/api/v1/students/:id`. Express кладёт шаблон в `req.route`, когда маршрут
 * найден; если его нет, берётся адрес без строки запроса — она может содержать
 * поисковые слова и идентификаторы.
 */
const pathOf = (request: AuditableRequest): string => {
  const route: unknown = (request as { route?: unknown }).route;

  if (typeof route === 'object' && route !== null && 'path' in route) {
    const path: unknown = route.path;
    if (typeof path === 'string') return path;
  }

  return request.originalUrl.split('?')[0] ?? request.originalUrl;
};
