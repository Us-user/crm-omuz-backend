/**
 * Заготовка строки журнала, живущая ровно один запрос.
 *
 * Данные для неё появляются в трёх разных точках цикла Nest: имя действия —
 * там, где ещё видны метаданные обработчика (guard), идентификатор созданной
 * записи — в ответе (перехватчик), код ответа — в момент отправки. Поэтому
 * они складываются в сам запрос и собираются вместе, когда ответ уже ушёл.
 */
export interface AuditContext {
  /** Что сделали: `Students.Create`. */
  action: string;
  /** Над чем — если объект создан этим же запросом (в пути его ещё нет). */
  entityId: string | null;
  /** Кто — если токена не было, а обработчик назвал аккаунт (вход, регистрация). */
  actorId: string | null;
}

/** Символ, а не строка: заготовка не должна пересечься с полями Express. */
const AUDIT_CONTEXT = Symbol('audit.context');

type WithAuditContext = Record<symbol, AuditContext | undefined>;

export const setAuditContext = (request: object, context: AuditContext): void => {
  (request as WithAuditContext)[AUDIT_CONTEXT] = context;
};

/**
 * Заготовки нет — значит, запрос журналу не адресуется: это чтение, помеченный
 * `@NoAudit()` эндпоинт или запрос, до guard'а не дошедший.
 */
export const auditContextOf = (request: object): AuditContext | undefined =>
  (request as WithAuditContext)[AUDIT_CONTEXT];
