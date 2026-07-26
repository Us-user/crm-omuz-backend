import { GroupStudentStatus, StudentStatus } from '@prisma/client';

import { formatIsoDate } from '../common';
import type { GroupStudentRow } from './group-students.repository';

/**
 * Выгрузка и разбор состава группы в CSV (ТЗ 5.5: «Import/Export» на карточке
 * группы). Здесь только форма файла — правила и отказы живут в сервисе.
 */

/**
 * Заголовок выгрузки. Телефон стоит **первой** колонкой не для красоты:
 * это единственное поле, которое читает импорт, и файл, выгруженный отсюда,
 * должен без правки уходить обратно (сценарий «выгрузил → поправил список →
 * загрузил в другую группу»).
 */
export const GROUP_STUDENTS_CSV_HEADER = [
  'Телефон',
  'Фамилия',
  'Имя',
  'Статус в группе',
  'Причина',
  'Дата смены статуса',
  'Переведён из',
  'Дата зачисления',
  'Статус студента',
] as const;

/**
 * Названия колонки с телефоном, которые импорт принимает. Русское — из нашей же
 * выгрузки, английские — из ручного файла и чужих таблиц. Сравнение идёт
 * без учёта регистра и пробелов.
 */
export const PHONE_COLUMN_ALIASES = ['телефон', 'phone', 'номер', 'номер телефона'] as const;

/**
 * Статусы в файле — словами, а не кодами enum. Выгрузку открывает человек
 * в Excel (ТЗ 5.5), и `TRANSFERRED` в ячейке ему ничего не объясняет.
 * Обратное чтение от этого не страдает: импорт смотрит только на телефон.
 */
const MEMBERSHIP_STATUS_LABELS: Record<GroupStudentStatus, string> = {
  [GroupStudentStatus.ACTIVE]: 'Учится',
  [GroupStudentStatus.LEFT]: 'Покинул курс',
  [GroupStudentStatus.FINISHED]: 'Завершил курс',
  [GroupStudentStatus.TRANSFERRED]: 'Переведён в другую группу',
};

const STUDENT_STATUS_LABELS: Record<StudentStatus, string> = {
  [StudentStatus.ACTIVE]: 'Активен',
  [StudentStatus.NO_ACTIVE]: 'Неактивен',
  [StudentStatus.FINISHED]: 'Завершил обучение',
  [StudentStatus.BLOCK]: 'Заблокирован',
};

/**
 * Даты выгружаются как `YYYY-MM-DD`, без времени: в таблице читают день,
 * а не минуту, и календарная дата не втягивает читателя в часовые пояса
 * (то же решение, что для дат группы в сессии 0008). Полное время остаётся
 * в JSON-ответах API.
 */
const csvDate = (value: Date | null): string => (value === null ? '' : formatIsoDate(value));

/** Одна строка выгрузки — в порядке `GROUP_STUDENTS_CSV_HEADER`. */
export const toCsvRow = (row: GroupStudentRow): string[] => [
  row.student.phone,
  row.student.lastName,
  row.student.firstName,
  MEMBERSHIP_STATUS_LABELS[row.status],
  row.statusReason ?? '',
  csvDate(row.statusChangedAt),
  row.transferredFromGroup?.name ?? '',
  csvDate(row.enrolledAt),
  STUDENT_STATUS_LABELS[row.student.status],
];

/**
 * Ищет колонку с телефоном в строке заголовка. Апостроф в начале снимается:
 * его дописывает Excel (и наш собственный экранировщик формул).
 */
export const findPhoneColumn = (header: readonly string[]): number =>
  header.findIndex((cell) => {
    const normalized = cell.trim().replace(/^'/, '').toLowerCase();

    return (PHONE_COLUMN_ALIASES as readonly string[]).includes(normalized);
  });

/** Значение ячейки телефона: Excel любит дописывать апостроф перед `+`. */
export const readPhoneCell = (cell: string | undefined): string =>
  (cell ?? '').trim().replace(/^'/, '');
