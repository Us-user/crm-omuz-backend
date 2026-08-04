import { createHash } from 'node:crypto';

/** Ключ метаданных декоратора `@RateLimit()`. */
export const RATE_LIMIT_KEY = 'rateLimit:rule';

/** Общий префикс ключей лимитера в Redis: все счётчики видны одним `SCAN rl:*`. */
export const RATE_LIMIT_KEY_PREFIX = 'rl';

/** Длина отпечатка «кого считаем» в ключе — 128 бит, столкновений не бывает. */
const SUBJECT_HASH_LENGTH = 32;

/** Разумный потолок на значение из тела запроса: email по RFC — 254 символа. */
const SUBJECT_MAX_LENGTH = 254;

/** Что стоит во втором счётчике: логин (телефон) или адрес почты. */
export type RateLimitSubjectKind = 'phone' | 'email';

/** Окно лимита: сколько запросов и за какой срок. */
export interface RateLimitWindow {
  readonly limit: number;
  readonly windowSeconds: number;
}

/** Второй счётчик — «сколько раз спрашивали про этого человека». */
export interface RateLimitSubjectRule extends RateLimitWindow {
  /** Поле тела запроса, из которого берётся значение. */
  readonly field: string;
  /** Как значение приводится к канону: телефон — в E.164, почта — к нижнему регистру. */
  readonly kind: RateLimitSubjectKind;
}

/**
 * Правило эндпоинта. Счётчиков два, и они отвечают на разные вопросы:
 * `ip` — «сколько запросов пришло с этой машины», `subject` — «сколько раз
 * спрашивали про этот логин». С ботнета первый бессилен, из-за офисного NAT
 * второй не сработает — поэтому оба (решение пользователя, сессия 0040).
 */
export interface RateLimitRule {
  /** Имя действия — первая часть ключа, поэтому счётчики эндпоинтов не смешиваются. */
  readonly action: string;
  readonly ip: RateLimitWindow;
  readonly subject?: RateLimitSubjectRule;
}

/**
 * Ключ счётчика по адресу. Адрес хранится **открытым**: он не персональные
 * данные в том же смысле, что логин, а на разборе инцидента «кто нас долбит»
 * читаемый ключ и есть весь ответ.
 */
export function ipRateLimitKey(action: string, ip: string): string {
  return `${RATE_LIMIT_KEY_PREFIX}:${action}:ip:${ip}`;
}

/**
 * Ключ счётчика по логину. Значение **хешируется**: телефон и почта — это
 * ровно те персональные данные, вторую копию которых журнал действий решил
 * не хранить (0038), и класть их в Redis открытым текстом ради счётчика
 * значило бы завести ту же копию сбоку.
 */
export function subjectRateLimitKey(action: string, value: string): string {
  return `${RATE_LIMIT_KEY_PREFIX}:${action}:subject:${hashSubject(value)}`;
}

/** Отпечаток значения: SHA-256, обрезанный до 128 бит. */
export function hashSubject(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, SUBJECT_HASH_LENGTH);
}

/**
 * Адрес клиента. `request.ip` express выводит из `X-Forwarded-For`, только
 * если приложению задан `trust proxy` (`TRUST_PROXY`, см. `configureApp`) —
 * без него за обратным прокси все запросы придут с одного адреса, и лимит
 * закрыл бы вход всему центру разом.
 */
export function clientIpOf(request: { ip?: string; socket?: { remoteAddress?: string } }): string {
  return normalizeIp(request.ip ?? request.socket?.remoteAddress);
}

/**
 * Приводит адрес к одной форме: IPv4, пришедший по IPv6-сокету, выглядит как
 * `::ffff:203.0.113.7`, и без нормализации один клиент получил бы два счётчика.
 */
export function normalizeIp(raw: string | undefined | null): string {
  const value = raw?.trim();
  if (!value) return 'unknown';

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  return (mapped?.[1] ?? value).toLowerCase();
}

/**
 * Значение поля из тела запроса — в том виде, в каком его видит guard, то есть
 * **до** `ValidationPipe`: тело может быть чем угодно. Всё, что не годится
 * в ключ (не строка, пусто, слишком длинно), даёт `null` — тогда работает
 * только счётчик по адресу.
 */
export function subjectValueOf(body: unknown, field: string): string | null {
  if (typeof body !== 'object' || body === null) return null;

  const raw = (body as Record<string, unknown>)[field];
  if (typeof raw !== 'string') return null;

  const value = raw.trim();
  if (value === '' || value.length > SUBJECT_MAX_LENGTH) return null;

  return value;
}

/**
 * Сколько ждать до следующей попытки. `PTTL` отдаёт `-1` у ключа без срока
 * и `-2` у исчезнувшего — в обоих случаях честнее назвать полное окно, чем
 * пообещать «через секунду».
 */
export function retryAfterSeconds(ttlMs: number, windowSeconds: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return windowSeconds;
  return Math.max(1, Math.ceil(ttlMs / 1000));
}

/**
 * Лимит исчерпан. `INCR` возвращает 1 на первом запросе, поэтому при `limit = 3`
 * проходят запросы 1–3, а отбивается четвёртый.
 */
export function isExceeded(hits: number, limit: number): boolean {
  return hits > limit;
}
