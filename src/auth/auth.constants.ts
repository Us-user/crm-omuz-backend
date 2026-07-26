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
