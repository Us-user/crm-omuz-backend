import { BadRequestException } from '@nestjs/common';

/** Дата без времени: `YYYY-MM-DD`. Разбор часового пояса не нужен и только вредит. */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Разбирает календарную дату из `YYYY-MM-DD` в полночь UTC.
 *
 * Формат обычно уже проверен DTO; здесь отсекаются несуществующие даты.
 * Сравнение с обратным преобразованием обязательно: `new Date` не отвергает
 * лишний день, а молча переносит его на следующий месяц (`2004-02-30` → 1 марта).
 *
 * @param field имя поля — попадает в `details` ошибки, чтобы клиент подсветил вход.
 * @throws BadRequestException если такой даты не существует (400 VALIDATION_ERROR).
 */
export function parseIsoDate(value: string, field: string, message = 'Некорректная дата'): Date {
  const date = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException({
      message,
      details: { [field]: `Даты «${value}» не существует` },
    });
  }

  return date;
}

/**
 * Обратная операция: календарная дата → `YYYY-MM-DD`.
 *
 * Колонки `@db.Date` приезжают из Prisma как полночь UTC. Отдавать их полным
 * ISO-временем значило бы обещать клиенту точность, которой в столбце нет,
 * и втягивать его в разбор часовых поясов там, где времени вообще не было.
 */
export const formatIsoDate = (date: Date): string => date.toISOString().slice(0, 10);
