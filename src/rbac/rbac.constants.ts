/** Ключ метаданных декоратора `@RequirePermission()`. */
export const PERMISSIONS_KEY = 'rbac:permissions';

/**
 * Позиция-суперпользователь (ТЗ 3.2: «раздел Accounting виден только позиции Director»).
 * Единственная позиция, на которую опирается правило доступа по имени, поэтому она
 * системная: её нельзя удалить, переименовать или урезать в правах.
 */
export const DIRECTOR_POSITION_NAME = 'Director';

/**
 * Справочник позиций из ТЗ 3.2 — стартовый набор, дальше им управляет администратор
 * (`/positions`, Фаза 2). Заводится один раз миграцией, поэтому удалённая позиция
 * не воскресает при перезапуске; исключение — `Director`, см. `DIRECTOR_POSITION_NAME`.
 */
export const DEFAULT_POSITIONS: readonly { name: string; description: string }[] = [
  { name: 'Director', description: 'Руководитель центра: полный доступ, включая бухгалтерию' },
  { name: 'Admin', description: 'Администратор системы' },
  { name: 'Manager', description: 'Менеджер: студенты, группы, лиды' },
  { name: 'Mentor', description: 'Ментор: свои группы, журнал, материалы' },
  { name: 'Developer', description: 'Разработчик' },
];
