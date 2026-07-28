import { Gender, LeadType } from '@prisma/client';

import { formatDayTime, formatIsoDate, formatIsoMonth } from '../common';
import type { LeadRow } from './leads.repository';

/**
 * Выгрузка лидов в CSV (ТЗ 5.7: «Export»). Здесь только форма файла — отбор
 * строк и права живут в сервисе и контроллере.
 *
 * Читать этот файл обратно нечем и не нужно: ТЗ 5.7 просит только выгрузку,
 * а импорта лидов не существует (в отличие от состава группы, 0013). Поэтому
 * колонок здесь ровно столько, сколько полей у формы обращения: файл открывают,
 * чтобы посмотреть и посчитать, а не чтобы загрузить назад.
 */

/**
 * Заголовок выгрузки — вся форма ТЗ 5.7 плюс то, что о лиде знает система
 * (стадия с датой перехода, факт перевода, дата обращения).
 *
 * Телефон первой колонкой — тем же порядком, что в выгрузке состава группы
 * (0013): оператор открывает оба файла в одной таблице, и человек в них
 * узнаётся по номеру.
 */
export const LEADS_CSV_HEADER = [
  'Телефон',
  'Фамилия',
  'Имя',
  'Email',
  'Дата рождения',
  'Пол',
  'Род занятий',
  'Стадия',
  'Дата перехода в клиенты',
  'Месяц записи',
  'Курс',
  'Время урока',
  'Филиал',
  'Купон',
  'Источник',
  'UTM source',
  'UTM medium',
  'UTM campaign',
  'Заметки',
  'Переведён в студенты',
  'Дата перевода',
  'Дата обращения',
] as const;

/**
 * Перечисления в файле — словами, а не кодами enum (правило 0013): выгрузку
 * открывает человек в Excel, и `CLIENT` в ячейке ему ничего не объясняет.
 */
const LEAD_TYPE_LABELS: Record<LeadType, string> = {
  [LeadType.LEAD]: 'Лид',
  [LeadType.CLIENT]: 'Клиент',
};

const GENDER_LABELS: Record<Gender, string> = {
  [Gender.MALE]: 'Мужской',
  [Gender.FEMALE]: 'Женский',
};

/**
 * Даты выгружаются как `YYYY-MM-DD`, без времени: в таблице читают день,
 * а не минуту (то же решение, что в выгрузке состава, 0013). Полное время
 * остаётся в JSON-ответах API.
 */
const csvDate = (value: Date | null): string => (value === null ? '' : formatIsoDate(value));

/** Одна строка выгрузки — в порядке `LEADS_CSV_HEADER`. */
export const toCsvRow = (row: LeadRow): string[] => [
  row.phone,
  row.lastName,
  row.firstName,
  row.email ?? '',
  csvDate(row.birthDate),
  row.gender === null ? '' : GENDER_LABELS[row.gender],
  row.occupation ?? '',
  LEAD_TYPE_LABELS[row.type],
  csvDate(row.becameClientAt),
  row.enrollMonth === null ? '' : formatIsoMonth(row.enrollMonth),
  row.course?.title ?? '',
  row.lessonTimeMinute === null ? '' : formatDayTime(row.lessonTimeMinute),
  row.branch?.name ?? '',
  row.coupon?.name ?? '',
  row.source ?? '',
  row.utmSource ?? '',
  row.utmMedium ?? '',
  row.utmCampaign ?? '',
  row.notes ?? '',
  // «Переведён» выводится из ссылки на профиль, а не из отдельного флага —
  // то же правило, что в JSON-ответе (флаг и ссылка могли бы разойтись).
  row.convertedStudentId === null ? 'Нет' : 'Да',
  csvDate(row.convertedAt),
  csvDate(row.createdAt),
];
