import { BadRequestException } from '@nestjs/common';

/** Календарный месяц без дня: `YYYY-MM`. */
export const ISO_MONTH_PATTERN = /^\d{4}-\d{2}$/;

/**
 * Разбирает месяц из `YYYY-MM` в первое его число (полночь UTC).
 *
 * Месяц хранится колонкой `@db.Date` (первое число), а не парой чисел
 * «год + месяц»: тогда «уровни за квартал» (ТЗ 5.16) — обычный диапазон,
 * а не арифметика. Нормализация к первому числу живёт здесь, чтобы
 * в БД не мог попасть месяц, начинающийся пятнадцатого.
 *
 * Формат обычно уже проверен DTO; здесь отсекается несуществующий месяц
 * (`2026-13`) — ровно как `parseIsoDate` отсекает 30 февраля.
 *
 * @param field имя поля — попадает в `details` ошибки, чтобы клиент подсветил вход.
 * @throws BadRequestException если месяца не существует (400 VALIDATION_ERROR).
 */
export function parseIsoMonth(value: string, field: string): Date {
  const month = ISO_MONTH_PATTERN.test(value)
    ? new Date(`${value}-01T00:00:00.000Z`)
    : new Date(Number.NaN);

  if (Number.isNaN(month.getTime()) || formatIsoMonth(month) !== value) {
    throw new BadRequestException({
      message: 'Некорректный месяц',
      details: { [field]: `Месяца «${value}» не существует, ожидается формат YYYY-MM` },
    });
  }

  return month;
}

/**
 * Обратная операция: первое число месяца → `YYYY-MM`.
 *
 * День наружу не уходит: в столбце он всегда первый и никакого смысла
 * не несёт — показывать его значило бы обещать точность, которой нет
 * (то же соображение, что у `formatIsoDate` про время).
 */
export const formatIsoMonth = (month: Date): string => month.toISOString().slice(0, 7);

/**
 * Первое число **следующего** месяца — правая, не включающая граница отрезка.
 *
 * Нужна там, где отбираются записи «за месяц» по обычной дате: недели журнала
 * лежат в `startDate` (`@db.Date`), и условие `gte: месяц, lt: следующий`
 * не зависит от того, сколько в месяце дней. Считать `lte: последний день`
 * значило бы выводить это число самому — 28, 29, 30 или 31.
 *
 * `Date.UTC` переносит год сам: декабрь + 1 = январь следующего года.
 */
export const nextIsoMonth = (month: Date): Date =>
  new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
