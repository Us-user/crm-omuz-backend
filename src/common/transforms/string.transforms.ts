/** Обрезает пробелы по краям строки; нестроковые значения пропускает как есть. */
export const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Приводит email к каноничному виду: без пробелов, в нижнем регистре.
 * Нужно, чтобы `Ivan@Mail.ru` и `ivan@mail.ru` не создали два аккаунта.
 */
export const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * Значение необязательного текстового поля формы для записи в БД.
 *
 * Разводит два разных намерения, которые в JSON выглядят похоже:
 * поля нет (`undefined`) — «не трогать», пустая строка — «очистить».
 * Без этого очистить описание через `PUT` было бы нечем.
 */
export const emptyToNull = (value: string | undefined): string | null =>
  value === undefined || value === '' ? null : value;

/**
 * То же для `PUT`, где само поле может быть не передано: `undefined` доходит
 * до Prisma и означает «колонку не менять».
 */
export const emptyToNullPatch = (value: string | undefined): string | null | undefined =>
  value === undefined ? undefined : emptyToNull(value);
