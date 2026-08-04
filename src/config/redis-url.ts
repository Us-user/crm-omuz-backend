/** Параметры подключения к Redis в том виде, в каком их принимают ioredis и BullMQ. */
export interface RedisConnectionOptions {
  host: string;
  port: number;
  /** ACL-пользователь (Redis 6+). У облачных провайдеров бывает `default`. */
  username?: string;
  password?: string;
  db: number;
  /** Схема `rediss://` — соединение поверх TLS. */
  tls: boolean;
}

/** Порт Redis по умолчанию — если в строке подключения он не указан. */
const DEFAULT_REDIS_PORT = 6379;

/**
 * Разбирает строку подключения (`redis://` или `rediss://`) в отдельные поля.
 *
 * Зачем это нужно: облачные провайдеры (Render Key Value, Upstash, Redis Cloud)
 * выдают **одну строку**, а и `RedisService`, и BullMQ принимают набор полей.
 * Разбор в одном месте оставляет обоим потребителям один и тот же путь
 * получения настроек — иначе строку пришлось бы разбирать дважды, и однажды
 * они разошлись бы (например, по TLS).
 *
 * @throws Error с внятной причиной — вызывается при старте, и приложение
 * должно упасть сразу, а не подключаться в никуда (ТЗ 3.8).
 */
export function parseRedisUrl(raw: string): RedisConnectionOptions {
  const value = raw.trim();

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`REDIS_URL: не удалось разобрать строку подключения «${value}»`);
  }

  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(
      `REDIS_URL: ожидается схема redis:// или rediss://, получено «${url.protocol}»`,
    );
  }

  if (url.hostname === '') {
    throw new Error(`REDIS_URL: в строке подключения нет хоста`);
  }

  return {
    host: url.hostname,
    port: url.port === '' ? DEFAULT_REDIS_PORT : Number(url.port),
    // Пустые значения — это «не задано»: у Render во внутреннем URL логина
    // и пароля нет вовсе, и передавать пустую строку в ioredis нельзя.
    username: emptyToUndefined(decodeURIComponent(url.username)),
    password: emptyToUndefined(decodeURIComponent(url.password)),
    db: databaseOf(url.pathname),
    tls: url.protocol === 'rediss:',
  };
}

/** Номер базы стоит путём (`/0`); без него — нулевая, как у ioredis по умолчанию. */
function databaseOf(pathname: string): number {
  const raw = pathname.replace(/^\//, '');
  if (raw === '') return 0;

  const db = Number(raw);
  if (!Number.isInteger(db) || db < 0) {
    throw new Error(`REDIS_URL: некорректный номер базы «${raw}»`);
  }

  return db;
}

const emptyToUndefined = (value: string): string | undefined => (value === '' ? undefined : value);
