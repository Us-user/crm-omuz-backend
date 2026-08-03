import { HttpStatus } from '@nestjs/common';

import { PERMISSION_PREFIX, PERMISSION_SEPARATOR } from '../rbac/permission-catalog';

/**
 * Правила журнала действий (ТЗ 3.6) — чистыми функциями, как правила журнала
 * успеваемости (0019), рассылок (0036) и расписания (0037). Guard и перехватчик
 * остаются тонкими: они достают данные из запроса, а решает всё это —
 * и проверяется без HTTP.
 */

/**
 * Методы, которые считаются действием. Чтения (GET/HEAD/OPTIONS) в журнал
 * не пишутся: ТЗ 3.6 просит журнал **действий**, а списки и дашборд
 * опрашиваются постоянно — их строки похоронили бы настоящие действия.
 */
const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const isAuditableMethod = (method: string): boolean =>
  MUTATING_METHODS.has(method.toUpperCase());

/** Исход действия — выводится из кода ответа, а не хранится колонкой. */
export enum AuditOutcome {
  /** Действие состоялось (2xx). */
  Success = 'SUCCESS',
  /** Отказ доступа: не аутентифицирован или нет права (401/403). */
  Denied = 'DENIED',
}

// Коды ответа приезжают из Express числами, поэтому границы объявлены числами:
// сравнение `number` с членом перечисления `HttpStatus` линтер справедливо
// считает небезопасным — перечисление могло бы быть и строковым.
const FIRST_ERROR_STATUS: number = HttpStatus.BAD_REQUEST;
const UNAUTHORIZED_STATUS: number = HttpStatus.UNAUTHORIZED;
const FORBIDDEN_STATUS: number = HttpStatus.FORBIDDEN;

export const outcomeOf = (statusCode: number): AuditOutcome =>
  statusCode < FIRST_ERROR_STATUS ? AuditOutcome.Success : AuditOutcome.Denied;

/**
 * Что попадает в журнал: **успешные действия и отказы доступа**.
 *
 * Ошибки формы (400) и нарушения бизнес-правил (422) — не действия, а отбитые
 * запросы: одна опечатка на фронте залила бы ими таблицу. Ошибки сервера (500)
 * уходят в лог приложения со стектрейсом (0001), и там от них больше пользы.
 */
export const isRecordableStatus = (statusCode: number): boolean =>
  statusCode < FIRST_ERROR_STATUS ||
  statusCode === UNAUTHORIZED_STATUS ||
  statusCode === FORBIDDEN_STATUS;

/**
 * Код действия из кода права: `Permission.Students.Create` → `Students.Create`.
 *
 * Второго перечня действий в проекте не заводится — эндпоинт уже объявил,
 * чем он является, декоратором `@RequirePermission` (0005). Отдельный список
 * «действие → название» разошёлся бы с правами при первой же правке.
 */
const CODE_PREFIX = `${PERMISSION_PREFIX}${PERMISSION_SEPARATOR}`;

export const actionFromPermission = (code: string): string =>
  code.startsWith(CODE_PREFIX) ? code.slice(CODE_PREFIX.length) : code;

/**
 * Запасное имя действия для эндпоинтов **без** права каталога: кабинет ментора
 * и вход в систему (там разрешением служит менторство или его отсутствие).
 * Имя выводится из класса и обработчика, поэтому пустым не бывает никогда.
 */
export const fallbackAction = (controller: string, handler: string): string =>
  `${controller.replace(/Controller$/, '')}${PERMISSION_SEPARATOR}${handler}`;

/**
 * Ответ обработчика в том виде, в каком его читает журнал.
 *
 * `TransformResponseInterceptor` заворачивает ответ в `{ data }` (0001), и какой
 * из двух перехватчиков окажется снаружи, зависит от порядка регистрации
 * модулей. Вместо того чтобы полагаться на этот порядок, разворачиваем обёртку
 * здесь: журнал должен одинаково видеть `{ id }` и `{ data: { id } }`.
 */
const payloadOf = (result: unknown): unknown => {
  if (result !== null && typeof result === 'object' && 'data' in result) {
    return result.data;
  }

  return result;
};

/** Длина идентификатора объекта, дальше которой строка в путь не годится. */
const MAX_ENTITY_ID = 64;

const stringField = (source: unknown, field: string): string | null => {
  if (source === null || typeof source !== 'object') return null;

  const value = (source as Record<string, unknown>)[field];

  return typeof value === 'string' && value !== '' && value.length <= MAX_ENTITY_ID ? value : null;
};

/**
 * Над чем действие, если объект назван в пути (`PUT /students/:id`).
 * Не `@db.Uuid`-строгая проверка: ключом бывает и месяц
 * (`DELETE /leaders/winners/2026-07`).
 */
export const entityIdFromParams = (params: unknown): string | null => stringField(params, 'id');

/**
 * Над чем действие, если объект **создан** этим же запросом: в пути его ещё нет,
 * и без ответа обработчика строка «завёл студента» не сказала бы, какого именно.
 */
export const entityIdFromResult = (result: unknown): string | null =>
  stringField(payloadOf(result), 'id');

/**
 * Действующее лицо у **неаутентифицированного** запроса: вход и регистрация
 * (ТЗ 5.1) отвечают карточкой аккаунта, и это единственный способ узнать «кто»
 * там, где токена ещё нет. Строка без действующего лица требования ТЗ 3.6
 * («кто, что, когда») не выполняет, поэтому случай разобран отдельно.
 */
export const actorIdFromResult = (result: unknown): string | null => {
  const payload = payloadOf(result);
  if (payload === null || typeof payload !== 'object') return null;

  return stringField((payload as { account?: unknown }).account, 'id');
};

/** Длина, до которой обрезаются строки клиента: столько же берёт сессия (0002). */
export const MAX_CLIENT_FIELD = 255;

export const truncate = (
  value: string | undefined | null,
  max = MAX_CLIENT_FIELD,
): string | null =>
  value === undefined || value === null || value === '' ? null : value.slice(0, max);
