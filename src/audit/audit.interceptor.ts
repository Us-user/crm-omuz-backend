import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs';

import { actorIdFromResult, entityIdFromResult } from './audit';
import { auditContextOf } from './audit.context';

/**
 * Дополняет заготовку строки журнала тем, что известно **только из ответа**
 * обработчика: идентификатором созданной записи и — у входа и регистрации —
 * аккаунтом действующего лица.
 *
 * Саму строку пишет `AuditContextGuard` в момент отправки ответа. Разделение
 * вынужденное и объяснимое: guard видит метаданные обработчика и успевает
 * подписаться до отказа в правах, но не видит ответа; перехватчик видит ответ,
 * но до него не доходят 401 и 403. Поэтому у каждого — своя половина, а сходятся
 * они в заготовке, живущей один запрос.
 *
 * Если заготовки нет, запрос журналу не адресуется (чтение или `@NoAudit()`) —
 * и перехватчик не делает ничего.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const stash = auditContextOf(context.switchToHttp().getRequest<object>());
    if (stash === undefined) return next.handle();

    return next.handle().pipe(
      tap((result) => {
        stash.entityId = entityIdFromResult(result);
        stash.actorId = actorIdFromResult(result);
      }),
    );
  }
}
