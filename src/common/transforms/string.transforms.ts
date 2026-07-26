/** Обрезает пробелы по краям строки; нестроковые значения пропускает как есть. */
export const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Приводит email к каноничному виду: без пробелов, в нижнем регистре.
 * Нужно, чтобы `Ivan@Mail.ru` и `ivan@mail.ru` не создали два аккаунта.
 */
export const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
