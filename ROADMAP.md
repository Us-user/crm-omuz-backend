# ROADMAP — Бэкенд CRM «Omuz»

> Дорожная карта разработки на основе `TZ_CRM_Omuz_FINAL.md` (v1.0).
> Разбита на фазы по зависимостям: каждая следующая опирается на предыдущие.
>
> **Легенда статусов:** `[ ]` не начато · `[~]` в работе · `[x]` готово
>
> Правила ведения:
> - Отмечать пункт `[x]` только когда он реально реализован и проверен (тесты/ручная проверка).
> - Внутри фазы можно двигаться по подпунктам; фаза считается закрытой, когда закрыты все её подпункты.
> - Прогресс каждой сессии фиксируется в `sessions/` (см. `sessions/README.md`).

**Стек:** TypeScript · NestJS · PostgreSQL · Prisma · Redis + BullMQ · JWT + Passport · argon2id · Swagger/OpenAPI · Pino · Docker · Jest + supertest.

**Общий прогресс:** Фаза 2 из 14 · 20 из 97 пунктов (~21%) — Фаза 0: 11/13 · **Фаза 1: 9/9 (закрыта)**

---

## Фаза 0 — Фундамент и инфраструктура
Цель: работающий каркас приложения, окружение, сквозные конвенции API.

- [x] Инициализация NestJS + TypeScript (strict), структура модульного монолита
- [x] Config-модуль: чтение и валидация `.env` (schema), `.env.example`
- [x] Подключение Prisma + PostgreSQL, первая миграция (пустая/health) — миграции применены в CI к реальному PostgreSQL, e2e подтверждает `database: up`
- [~] Redis + BullMQ: подключение, базовая очередь — приложение поднимается с реальным Redis в CI; **обработка задач очереди не прогонялась** (появится с Фазой 11)
- [~] Docker + `docker-compose` (app, postgres, redis) — файлы готовы, **не проверены** (Docker не установлен)
- [x] Логирование Pino (структурированное, request-id)
- [x] Глобальный формат ответа `{ data, meta }` и ошибок `{ error: { code, message, details } }`
- [x] Базовые DTO: пагинация (`page`, `limit`=20), сортировка, поиск, доменные фильтры
- [x] Глобальный `ValidationPipe` (class-validator), обработка HTTP-кодов 400/401/403/404/409/422/500
- [x] Swagger/OpenAPI на префиксе `/api/v1`
- [x] Health-check эндпоинт `GET /health`
- [x] Настройка Jest + supertest (unit + e2e каркас)
- [x] CI-заготовка (lint + test) — прогоняется на каждый push, зелёный: lint → typecheck → unit → `migrate deploy` → e2e

## Фаза 1 — Идентичность и аутентификация (Auth) · ТЗ 3.1, 5.1
Цель: аккаунты, вход, сессии, сброс пароля.

- [x] Prisma-модели: `Account`, `Student`, `Employee`, `Session` — миграция применена в CI к реальному PostgreSQL
- [x] Хеш пароля argon2id; нормализация телефона в E.164
- [x] Регистрация (`POST /auth/register`): имя, фамилия, ДР, адрес, email, телефон(уник, логин), тел. родителя, пароль ≥8
- [x] Вход `POST /auth/login` (телефон + пароль)
- [x] JWT: access 1ч / refresh 2 недели (Passport стратегии)
- [x] Ротация refresh (старый инвалидируется), серверные сессии
- [x] `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/logout-all`
- [x] Сброс пароля по email: `POST /auth/password/forgot`, `POST /auth/password/reset` (6-значный код, ~10 мин, лимит 3/час) — письмо через абстракцию `MailerService`; реальный провайдер подключается в Фазе 11
- [x] Основа перевода Студент → Сотрудник (сохранение логина и истории) — `POST /students/{id}/promote-to-employee`: аккаунт переезжает на профиль сотрудника (логин не меняется), профиль студента остаётся с учебной историей, связь в `Employee.formerStudentId`, сессии гасятся

## Фаза 2 — Роли, позиции и права (RBAC) · ТЗ 3.2, 5.15
Цель: гибкая система прав на каждом эндпоинте.

- [ ] Модели: `Position`, `Permission`, `EmployeePosition`, `Role`
- [ ] Каталог прав в нотации `Permission.<Раздел>.<Действие>`
- [ ] Права сотрудника = union прав всех его позиций
- [ ] Guard прав + декоратор `@RequirePermission(...)` на защищённых эндпоинтах — в Фазе 1 сделана грубая заготовка `@RequireAccountType(...)` + `AccountTypeGuard` (фильтр «сотрудник/студент»); она должна встать рядом, а не вместо
- [ ] CRUD позиций (`/positions`) + назначение прав из каталога
- [ ] Administration → Users: назначение ролей (`/admin/users`, `/admin/users/{id}/roles`)
- [ ] Administration → Permission: каталог (`GET/PUT /admin/permissions`)
- [ ] Пример правила: раздел Accounting доступен только позиции Director

## Фаза 3 — Учебный контур: справочники и структура · ТЗ 5.5, 5.6, 5.10, 5.17
Цель: филиалы, курсы с силлабусом, комнаты, группы с расписанием и составом.

- [ ] Модели: `Branch`, `Course`, `SyllabusLesson`, `ResourceFile`, `Room`, `Group`, `GroupMentor`, `ScheduleSlot`, `GroupStudent`, `Enrollment`
- [ ] Branches CRUD (`/branches`)
- [ ] Courses CRUD + поля (Fee, Is last course, цвета, лого, длительность) (`/courses`)
- [ ] Syllabus: уроки (Day N, Type Lecture/Practice/Exam, Show to group), файлы (`/courses/{id}/lessons`, `/lessons/{lid}/files`)
- [ ] Rooms CRUD (`/rooms`)
- [ ] Groups CRUD + фильтры Branch/Status/Course (`/groups`)
- [ ] Менторы группы (роли Teaching/Support) (`/groups/{id}/mentors`)
- [ ] Расписание группы — слоты (`/groups/{id}/schedule`)
- [ ] Состав студентов: add/transfer/change-status(с Reason)/import/export (`/groups/{id}/students...`)
- [ ] Категории активности (авто по среднему баллу: ChatGPT/Handsome/Advanced/Kettle/Black list)

## Фаза 4 — Студенты (Students) · ТЗ 5.3
Цель: админ-сторона и кабинет студента.

- [ ] Student CRUD + форма (пол, статус, доп. телефоны, филиал, Telegram, заметки, фото)
- [ ] Статусы: Active / No Active / Finished / Block
- [ ] Фильтры (name/Group/Course/Status/Contract), топ-студент (корона)
- [ ] Действия: invite, block, feedback (`/students/{id}/block|invite|feedback`)
- [ ] `Parent/Guardian`
- [ ] Кабинет студента (только просмотр): свои баллы, группы, профиль, рейтинг, расписание
- [ ] `GET /students/{id}/performance`

## Фаза 5 — Журнал/Progressbook + Успеваемость + Коины · ТЗ 5.8, 5.9
Цель: ядро успеваемости и начислений.

- [ ] Модели: `JournalWeek`, `JournalEntry`, `WeekResult`, `Performance`, `CoinBalance`, `CoinTransaction`
- [ ] Недели/дни: Att + Score(ДЗ ≤5), «отметить всех присутствующими»
- [ ] Начисление недели: `Sum = Σ(приходы) + Σ(ДЗ) + Exam + Bonus` (на экзамене приход не считается)
- [ ] Общий балл = среднее Sum по неделям → рейтинг/корона/категории
- [ ] Финализация недели `submit`: блокировка + автоначисление коинов + отчёт Директору (транзакция)
- [ ] Коины: ручное начисление (с reason, списание запрещено); авто по Sum (≥100→5, 90-99→4, 85-89→2, <85→0)
- [ ] `GET /students/{id}/coins`, `POST /students/{id}/coins`

## Фаза 6 — Сотрудники и менторы (Employees/Mentors) · ТЗ 5.4, 5.14
Цель: персонал, уровни менторов, аванс.

- [ ] Employee CRUD + форма (Position мультивыбор, Experience, Branch, Telegram, фото)
- [ ] Модели: `MentorLevel`, `MentorLevelHistory` (помесячно), `AvansRequest`
- [ ] Mentor levels CRUD (уровень + часовая ставка), история по месяцам
- [ ] Профиль ментора: Groups, Material, Timetable, Courses, SMS mailings
- [ ] Avans (заявка) `/employees/{id}/avans`

## Фаза 7 — Выпускники, сертификаты, покинувшие, лидеры · ТЗ 5.11, 5.12, 5.13
Цель: завершение жизненного цикла студента и рейтинги.

- [ ] Модели: `Graduate`, `Certificate`, `LeftCourse`, `MonthlyWinner`, `StudentActivityCategory`
- [ ] Автовыпуск при завершении группы курса с «Is last course»
- [ ] Graduates: статусы трудоустройства, Level, Points, сертификат (`/graduates`)
- [ ] Left courses (No Active + причина + дата) (`/left-courses`, `/left-courses/stats`)
- [ ] Leaders: топ-3, корона №1, Winners of last month (`/leaders`, `/leaders/winners`)

## Фаза 8 — Лиды/Клиенты и купоны (Marketing) · ТЗ 5.7
Цель: маркетинговый контур и воронка.

- [ ] Модели: `Lead` (Lead/Client), `Coupon`
- [ ] Leads CRUD + поля (UTM/referral, occupation, курс, время урока) (`/leads`)
- [ ] Transfer лидов в студенты (bulk/по строке), export (`/leads/transfer`, `/leads/export`)
- [ ] Coupons CRUD (курс(ы) + сумма TJS + период + Active/Inactive) (`/coupons`)

## Фаза 9 — Бухгалтерия (Accounting) · ТЗ 5.16 · только Director
Цель: финансы центра (транзакционно).

- [ ] Модели: `StudentPayment`, `PaymentTransaction`, `PaymentType`, `ExpenseCategory`, `Budget`, `BudgetCategory`, `Salary`, `DailySalary`, `SalaryTransaction`, `Debtor`, `AccountingPeriod`, `Transaction`
- [ ] Overview (Total/Paid/Not paid/Net, Income vs Expense) (`/accounting/overview`)
- [ ] Payments + Prepayment + чек, помесячное начисление = Fee, Debtor (`/accounting/payments`)
- [ ] Expenses (категории Tax/Office/Marketing/Employees) (`/accounting/expenses`)
- [ ] Budget (allocated/spent, период) (`/accounting/budget`)
- [ ] Salary: часы×ставка уровня месяца + Bonus, подтверждение Done (`/accounting/salary`)
- [ ] Avans approve/deny (`/accounting/avans/{id}/approve|deny`)
- [ ] Debtors (`/accounting/debtors`)
- [ ] Accounting periods: close Inprogress→Archive, выгрузка (`/accounting/periods`)

## Фаза 10 — Dashboard и Timetable · ТЗ 5.2, 5.10
Цель: агрегированные витрины (после наличия данных).

- [ ] Dashboard: summary, attendance, leads-stats, income, graduates, left-courses (`/dashboard/*`)
- [ ] Timetable day/week/month (агрегация слотов групп + ментор + комната) (`/timetable`)

## Фаза 11 — Уведомления и SMS-рассылки · ТЗ 3.4, 5.19
Цель: коммуникации через абстракцию отправителя.

- [ ] Модели: `SmsTemplate`, `Mailing`, `Notification`
- [~] Абстракция «отправитель сообщений» (Telegram основной, SMS опционально) — email-канал сделан в Фазе 1 (`MailerService` + заглушка в лог); осталось подключить реального провайдера почты, Telegram и SMS
- [ ] Рассылки: аудитории (Group/Students/Mentors/Leads/Graduates), Send (`/mailings`)
- [ ] Шаблоны CRUD + история (`/mailings/templates`, `/mailings/history`)
- [ ] Поздравления с ДР (частный случай), фоновые задачи BullMQ

## Фаза 12 — Генерация документов · ТЗ 3.7
Цель: PDF/Word по шаблонам.

- [ ] Договор студента (PDF/docx) (`/students/{id}/contracts/{cid}/export`)
- [ ] Сертификат выпускника (PDF) (`/graduates/{id}/certificate/export`)
- [ ] Чеки оплат (PDF/Word)
- [ ] Отчёт Accountant (период, выгрузка)

## Фаза 13 — Администрирование и вакансии · ТЗ 3.6, 5.15, 5.18
Цель: аудит и сервисные модули.

- [ ] Модель `AuditLog` + перехватчик действий (кто/что/когда)
- [ ] Administration → Logs (`/admin/logs`)
- [ ] Модель `Job` + Jobs CRUD (`/jobs`)

## Фаза 14 — Финализация и hardening · ТЗ 3.8, 7
Цель: продакшн-готовность.

- [ ] Rate-limiting (Redis) на auth и сброс пароля
- [ ] Локализация ru/en/tg (i18n контента и уведомлений)
- [ ] Индексы под фильтры (филиал, статус, даты)
- [ ] Транзакции для всех финансовых операций и начислений
- [ ] Полное покрытие тестами (unit + e2e), supertest сценарии
- [ ] Полнота OpenAPI (`openapi.yaml`), README, инструкции деплоя (HTTPS, секреты в env)

---

## Отложено / вне scope v1 (ТЗ §6)
- ⏸ Домашние задания (сдача/проверка)
- ❌ Реферальная программа
- ⏸ Трата коинов / магазин (механика начисления готова)
- ⏸ Применение купона к оплате
- Уточнить состав полей шаблонов документов
- Унификация терминов Role/Position
