# Техническое задание — Бэкенд CRM «Omuz» (обучающий центр)

**Версия:** 1.0 (финальная сборка)
**Дата:** 2026-07-20
**Основано на:** рабочем накопителе `TZ_CRM_Backend.md` (v0.41)

---

## 1. Обзор проекта

**Продукт:** серверная часть (бэкенд) CRM-системы для обучающего центра «Omuz» (Таджикистан).
Внутренний продукт компании: управление студентами, группами, преподавателями, успеваемостью,
финансами и маркетингом (лидами).

**Типы пользователей:**
- **Студенты** — учащиеся (минимальный доступ, только просмотр).
- **Сотрудники (Employees)** — персонал с одной или несколькими **позициями/ролями**
  (Admin, Manager, Mentor, Developer, Director…).

**Ключевые характеристики:**
- **Мультифилиальность:** один центр, несколько филиалов (Branch), напр. Sadbarg, Profsous.
  Не SaaS (одна организация).
- **Локализация:** 3 языка интерфейса — Русский, English, Тоҷикӣ.
- **Валюта:** сомони (TJS).
- **Уведомления:** Telegram (основной, бесплатный канал) и SMS (опционально).

**Основной жизненный цикл:**
`Лид (реклама) → Client (после пробного дня) → Студент → обучение по курсам/группам →
Выпускник (Graduate) → (опц.) Сотрудник (ментор)`.

---

## 2. Технологический стек и архитектура

| Слой | Технология | Обоснование |
|---|---|---|
| Язык | **TypeScript** | Строгая типизация для крупного проекта. |
| Фреймворк | **NestJS** | Модульность (ложится на деление ТЗ), DI, guards для RBAC, авто-Swagger. |
| БД | **PostgreSQL** | Реляционная, транзакции, JSONB, надёжна для связей CRM. |
| ORM | **Prisma** | Типобезопасность, миграции, читаемая схема. |
| Кэш/очереди | **Redis + BullMQ** | Кэш, rate-limit, фоновые задачи (уведомления, автоначисления). |
| Аутентификация | **JWT (access+refresh) + Passport** | Stateless API + серверные сессии. |
| Валидация | **class-validator / Zod** (DTO) | Валидация входных данных. |
| API | **REST + OpenAPI (Swagger)** | Автодокументация (см. `openapi.yaml`). |
| Хеш пароля | **argon2id** | Современный стандарт. |
| Тесты | **Jest + supertest** | Юнит + e2e. |
| Логирование | **Pino** | Структурированный лог. |
| Контейнеризация | **Docker + docker-compose** | Единое окружение. |
| Миграции | **Prisma Migrate** | Версионирование схемы. |

**Архитектурный подход:** модульный монолит на NestJS (один деплой, чёткие границы модулей;
при росте модуль можно вынести в сервис).

**Поток запроса:** `Controller (HTTP/DTO) → Service (бизнес-логика) → Repository (Prisma) → PostgreSQL`.

---

## 3. Сквозные требования

### 3.1. Аккаунты, аутентификация, сессии
- Один **Account** (идентичность/логин по номеру телефона). Пароль хранится как **argon2id**-хеш.
- К аккаунту привязан профиль **Student** ИЛИ **Employee** (не одновременно).
- Поддержан **перевод Студент → Сотрудник** (выпускник → ментор): данные переносятся,
  учебная история сохраняется, логин не меняется.
- **JWT:** access — 1 час, refresh — 2 недели.
- **Ротация refresh:** при обновлении выдаётся новый refresh, старый инвалидируется.
- **Серверные сессии:** активные refresh хранятся (БД/Redis) → «выйти» и «выйти со всех устройств».
- **Регистрация:** имя, фамилия, дата рождения, адрес, email, номер телефона (уникальный, логин),
  номер родителя, пароль (≥8 символов). Подтверждение при регистрации не требуется.
- **Сброс пароля:** по email → 6-значный код (~10 мин); лимит 3 попытки/час. По SMS — на будущее.
- **Номер телефона** нормализуется в формат E.164.

### 3.2. Роли, позиции и права (RBAC)
- **Сотрудник** имеет одну или несколько **позиций** (управляемый справочник: Admin, Manager,
  Mentor, Developer, Director…). Права сотрудника = **объединение (union)** прав всех его позиций.
- **Каталог прав (Permissions)** — настраивается в системе, нотация `Permission.<Раздел>.<Действие>`
  (напр. `Permission.Mentors.Views`). Права позиции назначаются из каталога (галочками).
- Роли пользователю назначаются в **Administration → Users**.
- Пример правила: раздел **Accounting виден только позиции Director**.
- Полномочия студента — только просмотр (свои баллы, свои группы, свой профиль, рейтинг, расписание).
- *(Термины «Role» и «Position» на этапе реализации держать раздельно; финально унифицировать.)*

### 3.3. Мультифилиальность и локализация
- Сущности привязаны к филиалу (Branch). Админ может работать в разрезе филиалов.
- Контент и уведомления учитывают язык пользователя (ru/en/tg).

### 3.4. Уведомления
- Каналы: **Telegram** (основной, бесплатно) и **SMS** (опционально).
- Провайдер за абстракцией «отправитель сообщений» (легко заменяется).
  Тест SMS: Twilio trial / Vonage sandbox. Прод SMS: местный таджикский агрегатор.
- Реализуется модулем SMS-рассылок (шаблоны + история). Поздравления с ДР — частный случай.

### 3.5. Конвенции API
- Базовый префикс: `/api/v1`.
- Единый формат ответа: `{ "data": ..., "meta": ... }`; ошибки: `{ "error": { "code", "message", "details" } }`.
- **Пагинация** списков: query `page`, `limit` (по умолчанию 20); в `meta` — `total`, `page`, `limit`.
- **Фильтрация/сортировка/поиск** — query-параметры (`search`, `sort`, доменные фильтры).
- Коды: 200/201 успех, 400 валидация, 401 неавторизован, 403 нет прав, 404 не найдено,
  409 конфликт (напр. номер занят), 422 бизнес-правило, 500 сервер.
- Аутентификация: заголовок `Authorization: Bearer <access>`.

### 3.6. Аудит и логирование
- **Administration → Logs**: журнал действий (кто, что, когда) — сущность `AuditLog`.
- Структурированные логи (Pino).

### 3.7. Генерация документов
- **Договор студента** — PDF/Word по шаблону.
- **Сертификат выпускника** — PDF (серийный №, ФИО, курс, дата, баллы).
- **Чеки оплат** — PDF/Word.
- **Отчёт Accountant** (период) — выгрузка.
- *(Шаблоны и списки полей уточняются перед разработкой.)*

### 3.8. Безопасность
- Rate-limiting (Redis) на аутентификацию и сброс пароля.
- Валидация всех DTO. Проверка прав (guards) на каждом защищённом эндпоинте.
- Хеш паролей argon2id; секреты в env; HTTPS на проде.

---

## 4. Модель данных (карта сущностей)

**Идентичность и доступ:** Account, Student, Employee, Position, Permission (M:N через связки),
EmployeePosition, Session, Role.

**Учебный контур:** Branch, Course, SyllabusLesson, ResourceFile, Group, GroupMentor (роль Teaching/Support),
ScheduleSlot, Room, GroupStudent, Enrollment.

**Успеваемость:** JournalWeek, JournalEntry (день: Att + Score), WeekResult (Bonus/Exam/Sum),
Performance (агрегаты), MentorLevel, MentorLevelHistory (помесячно).

**Студенческий контур:** Contract, Parent/Guardian, Feedback, Graduate, Certificate, LeftCourse,
StudentActivityCategory, MonthlyWinner, CoinTransaction, CoinBalance.

**Маркетинг:** Lead, Coupon.

**Финансы:** StudentPayment, PaymentTransaction, PaymentType (Cash/Alif/…), ExpenseCategory,
Budget, BudgetCategory, Salary, DailySalary, SalaryTransaction, AvansRequest, Debtor, AccountingPeriod, Transaction.

**Коммуникации/сервис:** SmsTemplate, Mailing, Notification, AuditLog, Job (вакансия).

> Полная ER-схема со связями — строится на этапе проектирования БД (Prisma schema).

---

## 5. Функциональные модули

> Формат: назначение · ключевые правила · основные эндпоинты (детально — в `openapi.yaml`).

### 5.1. Auth
Регистрация, вход (номер+пароль), JWT (1ч/2нед) с ротацией и сессиями, сброс пароля по email
(6-значный код, 10 мин, 3/час).
Эндпоинты: `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`,
`POST /auth/logout-all`, `POST /auth/password/forgot`, `POST /auth/password/reset`.

### 5.2. Dashboard
Сводная витрина (агрегатор): посещаемость за день, счётчики активных студентов/менторов,
активные группы (income за месяц + absent/late), статистика лидов, доход за месяц со сравнением,
график Attendance (Late/Absent), блоки Enroll / Employed graduates / Left courses.
Эндпоинты: `GET /dashboard/summary`, `GET /dashboard/attendance`, `GET /dashboard/leads-stats`,
`GET /dashboard/income`, `GET /dashboard/graduates`, `GET /dashboard/left-courses`.

### 5.3. Студенты (Students)
- **Админ-сторона:** список (сетка/таблица), фильтры (name/Group/Course/Status/Contract),
  статусы **Active / No Active / Finished / Block**, аккаунт опционален (Invite), топ-студент (корона),
  карточка (Feedback / Edit / Block / Delete), Performance, Groups с журналом, Create contract.
- **Статусы:** Active (учится), No Active (пауза/бросил, курс не завершён = «покинул»),
  Finished (прошёл курс), Block (блок входа, обратимо, ≠ Delete).
- **Кабинет студента (только просмотр):** свои баллы, свои группы, свой профиль, рейтинг (Leaders),
  расписание.
- Форма: имя, фамилия, дата рождения, пол, статус, адрес, email, телефон + доп. телефоны,
  филиал, Telegram, заметки, фото.
Эндпоинты: `GET/POST /students`, `GET/PUT/DELETE /students/{id}`, `POST /students/{id}/block`,
`POST /students/{id}/invite`, `POST /students/{id}/feedback`, `GET /students/{id}/performance`,
`POST /students/{id}/contracts`, `GET /students/{id}/contracts/{cid}/export?format=pdf|docx`.

### 5.4. Менторы (профиль)
Профиль ментора (частный случай сотрудника с позицией Mentor): уровень + часовая ставка,
Avans (заявка), группы (с расписанием), Congratulate (поздравление). Меню: Profile, Groups,
Material, Timetable, Courses, SMS mailings.

### 5.5. Группы (Groups)
- Список (сетка/таблица), фильтры Branch/Status/Course; счётчики **категорий активности**.
- Поля: название, описание, курс, формат (Online/Offline), филиал, даты, длительность (число+тип),
  вместимость (Required students), статус, Telegram-ссылка.
- **Required students** = набрано/вместимость; **Passing students** = успевающих из всех.
- **Детальная страница:** менторы (несколько, роли Teaching/Support), расписание (слоты день+время →
  Timetable), состав студентов, массовые **Change status** (с обязательной причиной = Reason) и
  **Transfer** в другую группу, Import/Export, секция Left course, клик по студенту → карточка «Students info».
- **Student activity:** студенты с points/category/absence за период.
- **Категории активности** (авто по среднему баллу за всё время):
  ChatGPT ≥95 · Handsome 80–94 · Advanced 65–79 · Kettle 45–64 · Black list <45.
Эндпоинты: `GET/POST /groups`, `GET/PUT/DELETE /groups/{id}`, `GET/POST/DELETE /groups/{id}/mentors`,
`GET/POST/PUT/DELETE /groups/{id}/schedule`, `GET/POST /groups/{id}/students`,
`POST /groups/{id}/students/transfer`, `POST /groups/{id}/students/change-status`,
`GET /groups/{id}/students/export`, `POST /groups/{id}/students/import`, `GET /groups/activity`.

### 5.6. Курсы (Courses)
- Каталог; поля: Title, Fee, Subtitle, Description, **Is last course** (Yes → триггер автовыпуска),
  Color1/Color2, Logo, Duration, кол-во групп.
- **Fee** — за курс; курсы длятся месяц (≈ помесячная оплата).
- **Syllabus:** уроки (Day N) — Title, Description, Type (Lecture/Practice/Exam), Status,
  **Show to group** (мультивыбор). У урока — файлы (Lecture/Practice/Homework), Resource: Title/Type/ResourceFileType.
- Подкатегория **Leads** — см. 5.8.
Эндпоинты: `GET/POST /courses`, `GET/PUT/DELETE /courses/{id}`,
`GET/POST /courses/{id}/lessons`, `GET/PUT/DELETE /courses/{id}/lessons/{lid}`,
`GET/POST /courses/{id}/lessons/{lid}/files`.

### 5.7. Лиды / Клиенты (Leads)
- **Lead** = пришёл; **Client** = после бесплатного пробного дня зарегался/заинтересовался.
- Поля: ФИО, телефон, email, дата рождения, пол, occupation, месяц записи, курс, время урока,
  notes, UTM/referral source, купон, тип Lead/Client.
- **Transfer в студенты** (bulk/по строке), Export, фильтры по датам/курсу.
- **Купоны:** курс(ы) + сумма (сомони) + период + Active/Inactive.
Эндпоинты: `GET/POST /leads`, `GET/PUT/DELETE /leads/{id}`, `POST /leads/transfer`,
`GET /leads/export`, `GET/POST /coupons`, `GET/PUT/DELETE /coupons/{id}`.

### 5.8. Журнал / Progressbook
- Недели (**NEW WEEK**); по дням: **Att** (посещаемость) + **Score** (ДЗ, до 5); в конце недели
  **Bonus / Exam / Sum**. График + Average. «Отметить всех присутствующими».
- **Начисление:** приход = 1 балл; на экзамене приход не считается.
  `Sum = Σ(приходы) + Σ(ДЗ по дням) + Exam + Bonus`.
- **Общий балл студента = среднее Sum по всем неделям** → рейтинг, корона, категории, Points выпускника.
- **Финализация недели («Отправить результат»):** неделя блокируется → автоначисление коинов →
  отчёт Директору.
- Вкладки: Journal, Exam graphics, **Google sheets** (встроенная таблица).
Эндпоинты: `GET /groups/{id}/journal`, `POST /groups/{id}/journal/weeks`,
`PUT /groups/{id}/journal/weeks/{wid}`, `POST /groups/{id}/journal/weeks/{wid}/mark-all-present`,
`POST /groups/{id}/journal/weeks/{wid}/submit`.

### 5.9. Система коинов (Coins) ⭐
- **Ручное начисление:** учителя/сотрудники (не студенты), обязательная причина. Списание запрещено.
- **Авто по итогам недели** (при «Отправить результат»), по Sum:
  ≥100 → 5 · 90–99 → 4 · 85–89 → 2 · <85 → 0.
- Баланс и история у студента. Назначение коинов (трата) — на будущее.
Эндпоинты: `GET /students/{id}/coins`, `POST /students/{id}/coins` (ручное, с reason).

### 5.10. Расписание (Timetable)
Календарь (Day/Week/Month) занятий всех групп: группа, время, Type, **аудитория (Room)**, ментор.
Источник — слоты групп + ментор + комната.
Эндпоинты: `GET /timetable?view=day|week|month&date=...`, `GET/POST/PUT/DELETE /rooms`.

### 5.11. Выпускники (Graduates)
- **Автовыпуск** при завершении срока группы курса с флагом «Is last course».
- Счётчики трудоустройства; статусы `#OpenToWork/#Work/#Freelancer/#FurtherEducation/Entrepreneur`.
- Виды Students/Groups; поля: Serial, Certificate (флаг+PDF), Level (лестница как у менторов),
  Points, Work place, Date of Issue.
Эндпоинты: `GET /graduates`, `GET/PUT /graduates/{id}`,
`GET /graduates/{id}/certificate/export`.

### 5.12. Покинувшие курсы (Left courses)
Студенты со статусом **No Active** + причина (свободный текст) и дата; группа/ментор на момент ухода.
Виды Students/Groups, помесячный график.
Эндпоинты: `GET /left-courses`, `GET /left-courses/stats`.

### 5.13. Лидеры / рейтинг (Leaders)
Рейтинг по общему баллу (среднее за весь период): топ-3, список, **корона** = №1,
Winners of the last month (снимок месяца). Фильтр по группе/курсу.
Эндпоинты: `GET /leaders`, `GET /leaders/winners?month=...`.

### 5.14. Сотрудники (Employees)
- Список (карточки/таблица), фильтры; карточка «Employer» (Experience, Account опционален, и т.д.).
- Форма: ФИО, дата рождения, телефон, email, адрес, **Position (мультивыбор)**, Experience,
  Branch, Telegram, Description, фото.
- **Позиции (Position)** — CRUD-справочник; назначение прав из каталога Permissions.
- **Mentor levels** — CRUD-справочник (уровень + **часовая ставка**); **история по месяцам**
  (уровень ментора хранится помесячно → зарплата по уровню месяца).
Эндпоинты: `GET/POST /employees`, `GET/PUT/DELETE /employees/{id}`,
`GET/POST/PUT/DELETE /positions`, `GET/POST/PUT/DELETE /mentor-levels`,
`GET/PUT /employees/{id}/mentor-levels` (история), `GET/POST /employees/{id}/avans`.

### 5.15. Администрирование (Administration)
- **Users** — все аккаунты (Type/Roles/Phone); назначение ролей (drawer Add roles).
- **Permission** — каталог прав (toggle).
- **Logs** — аудит по датам.
Эндпоинты: `GET /admin/users`, `POST/DELETE /admin/users/{id}/roles`,
`GET/PUT /admin/permissions`, `GET /admin/logs`.

### 5.16. Бухгалтерия (Accounting) — только Director
- **Обзор:** Total payment / Paid / Not paid / Net; Income vs Expense; Students payment по группам.
- **Payment's:** оплаты студентов (Amount/Paid/Status Active-Prepayment, скидки, тип Cash/Alif,
  чек PDF/Word, правка с причиной, **Prepayment** для текущего/нового студента).
- **Оплаты/долги:** помесячное начисление = Fee курса; **Not paid** = неоплаченный месяц;
  **Debtor** = сумма неоплаченных месяцев; статус помесячный.
- **Expenses:** категории (Tax→Income tax/VAT/Property/Social, Office, Marketing, Employees).
- **Budget:** план по категориям (allocated/spent, период, статус).
- **Salary:** Total/Prepaid/Remaining/Paid; Daily salaries (Default/Detail):
  **часы (по фактически проведённым занятиям) × часовая ставка уровня месяца + Bonus**, подтверждение Done.
- **Avans:** заявка ментора → Approve/Deny (сумма + причина); одобренный = Prepaid.
- **Debtors:** учёт долгов/рассрочек (период, общий долг, платёж/мес, выплачено, статус).
- **Accountant:** финансовые периоды-отчёты (income/expense/paid/notpaid/net, закрытие
  Inprogress→Archive, выгрузка).
Эндпоинты: `GET /accounting/overview`, `GET/POST /accounting/payments`,
`POST /accounting/payments/prepayment`, `GET/POST /accounting/expenses`,
`GET/POST/PUT /accounting/budget`, `GET /accounting/salary`, `POST /accounting/salary/{id}/pay`,
`GET/POST /accounting/avans`, `POST /accounting/avans/{id}/approve`, `POST /accounting/avans/{id}/deny`,
`GET/POST /accounting/debtors`, `GET /accounting/periods`, `POST /accounting/periods/{id}/close`.

### 5.17. Филиалы (Branches)
Список (график студентов по филиалам), карточка (город, район, адрес, телефон, статус, группы).
Эндпоинты: `GET/POST /branches`, `GET/PUT/DELETE /branches/{id}`.

### 5.18. Вакансии (Jobs)
Ручной список актуальных вакансий (CRUD админом). Поля уточняются (название, описание, компания,
требования, контакты, срок).
Эндпоинты: `GET/POST /jobs`, `GET/PUT/DELETE /jobs/{id}`.

### 5.19. SMS-рассылки (SMS mailings) / Уведомления
- Выбор аудитории: Group / Students / Mentors / Leads / Graduates.
- Составление (Title/Description/Template) → Send. **Шаблоны** (CRUD). **История** рассылок.
- Канал: Telegram (основной) / SMS. Провайдер за абстракцией.
Эндпоинты: `GET/POST /mailings`, `GET /mailings/history`,
`GET/POST/PUT/DELETE /mailings/templates`.

---

## 6. Отложено / вне scope (v1)
- **Домашние задания (сдача/проверка)** — ⏸ позже.
- **Реферальная программа** — ❌ не нужна.
- **Трата коинов / магазин** — ⏸ придумать позже (механика начисления готова).
- **Применение купона к оплате** — ⏸ уточнить.
- Шаблоны документов (договор/сертификат/чек/отчёт) — состав полей уточнить перед разработкой.
- Унификация терминов Role/Position; экран назначения прав позиции.

---

## 7. Нефункциональные требования
- Производительность: пагинация всех списков; индексы под фильтры (филиал, статус, даты).
- Масштабируемость: модульный монолит с возможностью выделения модулей.
- Надёжность: транзакции для финансовых операций и начислений коинов/зарплат.
- Безопасность: RBAC на каждом эндпоинте, argon2id, rate-limit, аудит.
- Наблюдаемость: структурные логи, аудит действий.
- Локализация: ru/en/tg.

---

## 8. Приложения
- **`openapi.yaml`** — полная Swagger/OpenAPI 3.1 спецификация с подробными описаниями эндпоинтов,
  схемами, примерами и кодами ошибок.
- **`TZ_CRM_Backend.md`** — рабочий накопитель с историей решений (журнал изменений) и открытыми вопросами.
