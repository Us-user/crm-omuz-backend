import { BadRequestException } from '@nestjs/common';

/** Время внутри суток: `HH:MM` от `00:00` до `23:59`. */
export const DAY_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Минут в сутках. Верхняя граница слота расписания — конец дня. */
export const MINUTES_IN_DAY = 24 * 60;

/**
 * Разбирает `HH:MM` в минуты от полуночи.
 *
 * Так время лежит и в БД (`ScheduleSlot.startMinute`): целое число сравнимо
 * и сортируемо без разбора часовых поясов, а пересечение слотов на нём
 * проверяется двумя неравенствами вместо арифметики над датами.
 *
 * Формат обычно уже проверен DTO; здесь он отсекается повторно, потому что
 * функция вызывается и из мест, куда значение приходит не из формы.
 *
 * @param field имя поля — попадает в `details` ошибки, чтобы клиент подсветил вход.
 * @throws BadRequestException если время не разбирается (400 VALIDATION_ERROR).
 */
export function parseDayTime(value: string, field: string): number {
  if (!DAY_TIME_PATTERN.test(value)) {
    throw new BadRequestException({
      message: 'Некорректное время',
      details: { [field]: `Ожидается время в формате HH:MM, получено «${value}»` },
    });
  }

  const [hours, minutes] = value.split(':').map(Number) as [number, number];

  return hours * 60 + minutes;
}

/** Обратная операция: минуты от полуночи → `HH:MM`. */
export const formatDayTime = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);

  return `${pad(hours)}:${pad(minutes % 60)}`;
};

const pad = (value: number): string => String(value).padStart(2, '0');
