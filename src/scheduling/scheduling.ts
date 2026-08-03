/**
 * Календарь и ключи фоновых задач (ТЗ 3.4) чистыми функциями.
 *
 * Здесь нет ни Nest, ни Redis: «какое сегодня число в поясе центра» и «ключ
 * рассылки за эту дату» — это арифметика над временем, и держать её рядом
 * с планировщиком значило бы проверять её только с живой очередью. Момент
 * времени всегда приходит параметром, а не берётся из `new Date()` внутри, —
 * иначе функции нельзя было бы проверить.
 */

/** Календарная дата без времени и пояса — то, чем оперирует «день рождения». */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const MINUTE_MS = 60_000;

const pad2 = (value: number): string => String(value).padStart(2, '0');
const pad4 = (value: number): string => String(value).padStart(4, '0');

/**
 * Календарная дата в поясе центра для данного момента UTC.
 *
 * Весь проект хранит время в UTC, но день рождения — понятие **местного** дня
 * (решение пользователя): в 02:00 по центру (UTC+5) в UTC ещё вчера, и без
 * сдвига именинника поздравили бы на сутки не в тот день. Сдвигаем момент
 * на смещение центра и читаем уже UTC-поля сдвинутого времени.
 */
export const centerToday = (now: Date, offsetMinutes: number): CalendarDate => {
  const shifted = new Date(now.getTime() + offsetMinutes * MINUTE_MS);

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
};

/** Ключ идемпотентности поздравлений за конкретную дату: `birthday:2026-08-03`. */
export const birthdaySystemKey = (date: CalendarDate): string =>
  `birthday:${pad4(date.year)}-${pad2(date.month)}-${pad2(date.day)}`;

/**
 * Предыдущий месяц в формате `YYYY-MM`.
 *
 * Считается в **UTC**, а не в поясе центра, — намеренно иначе, чем день
 * рождения: закрытие месяца рейтинга оперирует теми же UTC-месяцами, что и весь
 * учебный контур (`parseIsoMonth`, 0021), и второе понятие «месяц» здесь развело
 * бы снимок победителей с журналом. Задача стоит на первое число, когда прошлый
 * месяц уже закончился в любом поясе.
 */
export const previousUtcMonth = (now: Date): string => {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  return `${pad4(start.getUTCFullYear())}-${pad2(start.getUTCMonth() + 1)}`;
};
