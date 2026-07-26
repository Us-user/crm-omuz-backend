import type { PermissionSection } from './permission-catalog';

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

/**
 * Разделы каталога, права которых выдаются **только** системной позиции `Director`
 * (ТЗ 3.2: «раздел Accounting виден только позиции Director», ТЗ 5.16).
 *
 * Правило живёт здесь, а не в коде каждого эндпоинта: раздел закрывается целиком,
 * и проверять его при выдаче галочек надёжнее, чем при каждом запросе — иначе
 * право лежало бы у позиции, но не работало, и разбираться в этом пришлось бы
 * по исходникам. Список менять можно: если появится позиция «Accountant»,
 * достаточно убрать раздел отсюда.
 */
export const DIRECTOR_ONLY_SECTIONS: readonly PermissionSection[] = ['Accounting'];

/** Верхняя граница на число позиций в одном запросе назначения ролей. */
export const MAX_ROLES_PER_REQUEST = 20;
