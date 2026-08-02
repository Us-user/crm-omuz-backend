/**
 * Каталог прав (ТЗ 3.2) в нотации `Permission.<Раздел>.<Действие>`.
 *
 * Источник истины — этот файл, а не таблица `permissions`. Права раздаются
 * галочками в позициях, но **набор кодов** задаётся кодом: `@RequirePermission(...)`
 * ссылается на конкретную строку, и опечатка в ней означала бы право, которого
 * нет ни у кого, — эндпоинт молча стал бы недоступен всем. Здесь опечатка
 * не компилируется: тип `PermissionCode` выводится из каталога.
 *
 * В БД живут состояние переключателя (`isEnabled`, ТЗ 5.15) и описание;
 * приведение таблицы к каталогу делает `PermissionCatalogSyncService` при старте.
 *
 * Каталог покрывает все разделы ТЗ 5, включая ещё не написанные модули: коды
 * не мешают, пока их никто не требует, зато позиция настраивается один раз,
 * а не переделывается на каждой фазе.
 */

/** Общий префикс всех кодов (ТЗ 3.2: `Permission.Mentors.Views`). */
export const PERMISSION_PREFIX = 'Permission';

/** Разделитель частей кода. */
export const PERMISSION_SEPARATOR = '.';

const CATALOG = {
  Dashboard: {
    title: 'Дашборд',
    actions: { Views: 'Просмотр сводной витрины' },
  },
  Students: {
    title: 'Студенты',
    actions: {
      Views: 'Просмотр списка и карточек студентов',
      Create: 'Создание студента',
      Update: 'Редактирование студента',
      Delete: 'Удаление студента',
      Block: 'Блокировка и разблокировка входа',
      Invite: 'Приглашение студента (выдача аккаунта)',
      Feedback: 'Обратная связь по студенту',
      Promote: 'Перевод студента в сотрудники',
      Export: 'Выгрузка списка студентов',
    },
  },
  Contracts: {
    title: 'Договоры студентов',
    actions: {
      Views: 'Просмотр договоров',
      Create: 'Создание договора',
      Export: 'Выгрузка договора в PDF/Word',
    },
  },
  Parents: {
    title: 'Родители и опекуны',
    actions: {
      Views: 'Просмотр контактов родителей',
      Create: 'Добавление родителя',
      Update: 'Редактирование родителя',
      Delete: 'Удаление родителя',
    },
  },
  Employees: {
    title: 'Сотрудники',
    actions: {
      Views: 'Просмотр списка и карточек сотрудников',
      Create: 'Создание сотрудника',
      Update: 'Редактирование сотрудника',
      Delete: 'Удаление сотрудника',
    },
  },
  Mentors: {
    title: 'Менторы',
    actions: {
      Views: 'Просмотр профилей менторов',
      ManageLevels: 'Ведение уровней ментора по месяцам',
    },
  },
  Positions: {
    title: 'Позиции и права',
    actions: {
      Views: 'Просмотр позиций и их прав',
      Create: 'Создание позиции',
      Update: 'Редактирование позиции и её прав',
      Delete: 'Удаление позиции',
    },
  },
  MentorLevels: {
    title: 'Справочник уровней ментора',
    actions: {
      Views: 'Просмотр уровней и ставок',
      Create: 'Создание уровня',
      Update: 'Редактирование уровня и ставки',
      Delete: 'Удаление уровня',
    },
  },
  Avans: {
    title: 'Авансы',
    actions: {
      Views: 'Просмотр заявок на аванс',
      Create: 'Подача заявки на аванс',
      Approve: 'Одобрение и отклонение заявки',
    },
  },
  Branches: {
    title: 'Филиалы',
    actions: {
      Views: 'Просмотр филиалов',
      Create: 'Создание филиала',
      Update: 'Редактирование филиала',
      Delete: 'Удаление филиала',
    },
  },
  Courses: {
    title: 'Курсы',
    actions: {
      Views: 'Просмотр курсов',
      Create: 'Создание курса',
      Update: 'Редактирование курса',
      Delete: 'Удаление курса',
    },
  },
  Syllabus: {
    title: 'Силлабус и материалы',
    actions: {
      Views: 'Просмотр уроков и файлов',
      Create: 'Добавление урока или файла',
      Update: 'Редактирование урока',
      Delete: 'Удаление урока или файла',
    },
  },
  Groups: {
    title: 'Группы',
    actions: {
      Views: 'Просмотр групп',
      Create: 'Создание группы',
      Update: 'Редактирование группы',
      Delete: 'Удаление группы',
      ManageMentors: 'Назначение менторов группы',
      ManageSchedule: 'Ведение расписания группы',
      ManageStudents: 'Состав группы: добавление, перевод, смена статуса',
      Import: 'Импорт состава группы',
      Export: 'Выгрузка состава группы',
    },
  },
  Rooms: {
    title: 'Аудитории',
    actions: {
      Views: 'Просмотр аудиторий',
      Create: 'Создание аудитории',
      Update: 'Редактирование аудитории',
      Delete: 'Удаление аудитории',
    },
  },
  Timetable: {
    title: 'Расписание',
    actions: { Views: 'Просмотр общего расписания' },
  },
  Journal: {
    title: 'Журнал и успеваемость',
    actions: {
      Views: 'Просмотр журнала группы',
      Update: 'Проставление посещаемости и баллов',
      Submit: 'Финализация недели (блокировка и начисления)',
    },
  },
  Coins: {
    title: 'Коины',
    actions: {
      Views: 'Просмотр баланса и истории коинов',
      Create: 'Ручное начисление коинов',
    },
  },
  Leads: {
    title: 'Лиды и клиенты',
    actions: {
      Views: 'Просмотр лидов',
      Create: 'Создание лида',
      Update: 'Редактирование лида',
      Delete: 'Удаление лида',
      Transfer: 'Перевод лида в студенты',
      Export: 'Выгрузка лидов',
    },
  },
  Coupons: {
    title: 'Купоны',
    actions: {
      Views: 'Просмотр купонов',
      Create: 'Создание купона',
      Update: 'Редактирование купона',
      Delete: 'Удаление купона',
    },
  },
  Graduates: {
    title: 'Выпускники',
    actions: {
      Views: 'Просмотр выпускников',
      Update: 'Редактирование карточки выпускника',
      Certificate: 'Выдача и выгрузка сертификата',
    },
  },
  LeftCourses: {
    title: 'Покинувшие курсы',
    actions: { Views: 'Просмотр покинувших и статистики' },
  },
  Leaders: {
    title: 'Лидеры и рейтинг',
    actions: {
      Views: 'Просмотр рейтинга и победителей месяца',
      ManageWinners: 'Закрытие месяца: фиксация и снятие победителей',
    },
  },
  Accounting: {
    title: 'Бухгалтерия',
    actions: {
      Views: 'Доступ к разделу Accounting и обзору',
      ManagePayments: 'Оплаты студентов и предоплаты',
      ManageExpenses: 'Расходы и их категории',
      ManageBudget: 'Планирование бюджета',
      ManageSalary: 'Начисление и подтверждение зарплат',
      ManageDebtors: 'Учёт должников и рассрочек',
      ManagePeriods: 'Закрытие и выгрузка финансовых периодов',
    },
  },
  Mailings: {
    title: 'Рассылки и уведомления',
    actions: {
      Views: 'Просмотр рассылок, истории и доставок',
      Create: 'Составление рассылки',
      Update: 'Правка черновика рассылки',
      Delete: 'Удаление черновика рассылки',
      Send: 'Отправка рассылки и повтор упавших доставок',
      ManageTemplates: 'Ведение шаблонов сообщений',
    },
  },
  Jobs: {
    title: 'Вакансии',
    actions: {
      Views: 'Просмотр вакансий',
      Create: 'Создание вакансии',
      Update: 'Редактирование вакансии',
      Delete: 'Удаление вакансии',
    },
  },
  Administration: {
    title: 'Администрирование',
    actions: {
      ViewUsers: 'Просмотр всех аккаунтов',
      ManageUserRoles: 'Назначение и снятие ролей',
      ViewPermissions: 'Просмотр каталога прав',
      ManagePermissions: 'Переключение прав в каталоге',
      ViewLogs: 'Просмотр журнала действий',
    },
  },
} as const satisfies Record<string, { title: string; actions: Record<string, string> }>;

/** Раздел каталога (`Students`, `Accounting`, …). */
export type PermissionSection = keyof typeof CATALOG;

type ActionOf<S extends PermissionSection> = keyof (typeof CATALOG)[S]['actions'] & string;

/**
 * Все допустимые коды прав. Тип выводится из каталога, поэтому
 * `@RequirePermission('Permission.Students.Viwes')` не скомпилируется.
 */
export type PermissionCode = {
  [S in PermissionSection]: `${typeof PERMISSION_PREFIX}.${S}.${ActionOf<S>}`;
}[PermissionSection];

/** Запись каталога в том виде, в каком она ложится в таблицу `permissions`. */
export interface PermissionDefinition {
  readonly code: PermissionCode;
  readonly section: PermissionSection;
  readonly action: string;
  readonly description: string;
  /** Служебное право: переключателем каталога его выключить нельзя. */
  readonly isSystem: boolean;
}

/**
 * Права, которые нельзя выключить в каталоге: сняв доступ к управлению правами,
 * вернуть его через API было бы уже нечем — чинить пришлось бы запросом в БД.
 */
const NON_TOGGLEABLE: readonly PermissionCode[] = [
  'Permission.Administration.ViewPermissions',
  'Permission.Administration.ManagePermissions',
];

/** Собирает код из частей — единственное место, где строка склеивается. */
export const permissionCode = (section: string, action: string): string =>
  [PERMISSION_PREFIX, section, action].join(PERMISSION_SEPARATOR);

// `Object.entries` теряет литеральные типы ключей, поэтому раздел и действие
// приводятся обратно: их источник — сам `CATALOG`, других значений там быть не может.
export const PERMISSION_CATALOG: readonly PermissionDefinition[] = Object.entries(CATALOG).flatMap(
  ([section, { actions }]) =>
    Object.entries(actions).map(([action, description]): PermissionDefinition => {
      const code = permissionCode(section, action) as PermissionCode;

      return {
        code,
        section: section as PermissionSection,
        action,
        description,
        isSystem: NON_TOGGLEABLE.includes(code),
      };
    }),
);

/** Множество всех кодов — для проверки строк, пришедших извне. */
const CODES = new Set<string>(PERMISSION_CATALOG.map((permission) => permission.code));

const BY_CODE = new Map<string, PermissionDefinition>(
  PERMISSION_CATALOG.map((permission) => [permission.code, permission]),
);

/**
 * Раздел, к которому относится код. Нужен правилам вида «раздел Accounting
 * выдаётся только позиции Director» (ТЗ 3.2), где решение принимается по разделу,
 * а не по отдельному действию.
 */
export const permissionSectionOf = (code: PermissionCode): PermissionSection => {
  const definition = BY_CODE.get(code);
  // Тип `PermissionCode` выводится из каталога, поэтому запись здесь всегда есть.
  // Проверка оставлена, чтобы функция не возвращала `undefined` при вызове из JS.
  if (!definition) throw new Error(`Код права вне каталога: ${code}`);

  return definition.section;
};

/** Человекочитаемые названия разделов (для экрана каталога прав, ТЗ 5.15). */
export const PERMISSION_SECTION_TITLES: Readonly<Record<PermissionSection, string>> =
  Object.fromEntries(
    Object.entries(CATALOG).map(([section, { title }]) => [section, title]),
  ) as Record<PermissionSection, string>;

/** Проверка строки из запроса или из БД: есть ли такой код в каталоге. */
export const isPermissionCode = (value: string): value is PermissionCode => CODES.has(value);
