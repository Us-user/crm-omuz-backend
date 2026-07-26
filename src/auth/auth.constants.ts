/** Минимальная длина пароля (ТЗ 3.1). */
export const PASSWORD_MIN_LENGTH = 8;

/** Верхняя граница — argon2 всё равно хеширует любой размер, но защищает от «пароля» в мегабайт. */
export const PASSWORD_MAX_LENGTH = 128;

/** Имя passport-стратегии для access-токена. */
export const JWT_ACCESS_STRATEGY = 'jwt-access';

/** Ключ метаданных декоратора `@Public()`. */
export const IS_PUBLIC_KEY = 'auth:isPublic';

/** Тип токена в ответе (`Authorization: Bearer <access>`, ТЗ 3.5). */
export const TOKEN_TYPE = 'Bearer';

// --- Сброс пароля по email (ТЗ 3.1, 5.1) ---

/** Длина одноразового кода: ТЗ — 6 цифр. */
export const PASSWORD_RESET_CODE_LENGTH = 6;

/** Срок жизни кода. ТЗ: «~10 мин». */
export const PASSWORD_RESET_TTL_SECONDS = 10 * 60;

/**
 * ТЗ 3.1: «лимит 3 попытки/час». Формулировка покрывает оба смысла, поэтому
 * ограничены оба: и сколько раз можно запросить код, и сколько раз его вводить.
 */
export const PASSWORD_RESET_MAX_REQUESTS_PER_HOUR = 3;
export const PASSWORD_RESET_MAX_ATTEMPTS = 3;

/** Окно, в котором считаются запросы кода. */
export const PASSWORD_RESET_RATE_WINDOW_SECONDS = 60 * 60;
