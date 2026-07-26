# CRM «Omuz» — бэкенд

Серверная часть CRM обучающего центра «Omuz» (Таджикистан): студенты, группы, менторы,
успеваемость, финансы и маркетинг.

Требования — [`TZ_CRM_Omuz_FINAL.md`](./TZ_CRM_Omuz_FINAL.md), план работ — [`ROADMAP.md`](./ROADMAP.md),
история разработки — [`sessions/`](./sessions).

## Стек

TypeScript · NestJS · PostgreSQL · Prisma · Redis + BullMQ · JWT + Passport · argon2id ·
Swagger/OpenAPI · Pino · Docker · Jest + supertest.

Архитектура — модульный монолит. Поток запроса: `Controller → Service → Repository (Prisma) → PostgreSQL`.

## Быстрый старт

### Вариант 1 — Docker (поднимает всё)

```bash
cp .env.example .env
docker compose up --build
```

Поднимаются `postgres`, `redis` и `app`; миграции применяются автоматически
(`prisma migrate deploy`) перед стартом приложения.

### Вариант 2 — локально

Нужны запущенные PostgreSQL и Redis.

```bash
cp .env.example .env      # укажите свой DATABASE_URL и параметры Redis
npm install
npx prisma migrate deploy # или `npm run prisma:migrate` для дев-режима
npm run start:dev
```

- API: `http://localhost:3000/api/v1`
- Swagger: `http://localhost:3000/api/v1/docs`
- Health: `http://localhost:3000/health`

## Конвенции API

Базовый префикс — `/api/v1` (служебный `/health` вынесен из префикса).

**Успешный ответ:**

```json
{ "data": { "id": "..." } }
```

**Список (постраничный):**

```json
{
  "data": [],
  "meta": { "total": 137, "page": 1, "limit": 20, "totalPages": 7 }
}
```

Query-параметры списков: `page` (с 1), `limit` (по умолчанию 20, максимум 100),
`search`, `sort`, `order` (`asc`/`desc`) + доменные фильтры.

**Ошибка:**

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Ошибка валидации входных данных",
    "details": ["phone must be a valid phone number"],
    "requestId": "9f1c…",
    "timestamp": "2026-07-26T10:15:00.000Z"
  }
}
```

Коды: `VALIDATION_ERROR` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404),
`CONFLICT` (409), `UNPROCESSABLE_ENTITY` (422), `TOO_MANY_REQUESTS` (429), `INTERNAL_ERROR` (500).

`requestId` совпадает с заголовком `x-request-id` и с полем `req.id` в логах — по нему
запрос ищется в Pino-логах.

## Аутентификация

Заголовок `Authorization: Bearer <access>`. Access живёт 1 час, refresh — 2 недели.

**Закрыто по умолчанию:** `JwtAuthGuard` зарегистрирован глобально, поэтому новый эндпоинт
защищён сразу; открыть его можно только явно — декоратором `@Public()`.

| Эндпоинт | Назначение |
|---|---|
| `POST /api/v1/auth/register` | Регистрация студента (телефон — логин, пароль ≥8) |
| `POST /api/v1/auth/login` | Вход по номеру телефона и паролю |
| `POST /api/v1/auth/refresh` | Новая пара токенов; предъявленный refresh инвалидируется |
| `POST /api/v1/auth/logout` | Выход с текущего устройства |
| `POST /api/v1/auth/logout-all` | Выход со всех устройств |
| `POST /api/v1/auth/password/forgot` | Запрос 6-значного кода восстановления на email |
| `POST /api/v1/auth/password/reset` | Смена пароля по коду |

Как это устроено:

- пароли — **argon2id** (64 МиБ, 3 прохода); телефоны нормализуются в **E.164**,
  поэтому `901234567`, `992901234567` и `+992 (90) 123-45-67` — один и тот же логин;
- **серверные сессии**: строка `sessions` = одно устройство. В БД лежит только SHA-256
  от refresh-токена, сам токен не хранится;
- **ротация**: каждый обмен выдаёт новый refresh и заменяет отпечаток в сессии. Если
  предъявлен уже заменённый токен, сессия гасится целиком — так отрабатывается кража токена;
- вход отвечает одинаково на неизвестный номер и неверный пароль (и тратит одинаковое время),
  чтобы форму входа нельзя было использовать как проверку, кто зарегистрирован.

### Сброс пароля

Код из 6 цифр живёт 10 минут; не более **3 запросов кода в час** и **3 попыток ввода** на код —
на исчерпании код гасится досрочно. Смена пароля отзывает все сессии аккаунта.

- `password/forgot` отвечает одним и тем же текстом независимо от того, существует аккаунт
  или нет; заблокированному аккаунту код не отправляется — сброс не должен обходить блокировку;
- код хранится как **HMAC-SHA256 с `PASSWORD_RESET_SECRET`**, а не как argon2-хеш:
  6 цифр — это 10⁶ вариантов, быстрый хеш из утёкшего дампа обращается мгновенно, а медленный
  превратил бы публичный `password/forgot` в дорогую операцию (вектор DoS). Секрета нет в БД,
  поэтому перебор дампа бесполезен, а онлайн-перебор ограничен счётчиком попыток;
- письмо уходит через абстракцию `MailerService` на языке аккаунта (ru/en/tg).
  **Реальный провайдер пока не подключён:** `LogMailerService` пишет письмо в лог на уровне
  `debug` (для разработки задайте `LOG_LEVEL=debug`). Провайдер появится в Фазе 11.

## Переменные окружения

Все переменные валидируются при старте (`src/config/env.validation.ts`); при некорректном
значении приложение не поднимется. Полный список с описанием — в `.env.example`.
Секреты хранятся только в `.env` (в git не попадает).

`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` и `PASSWORD_RESET_SECRET` обязательны, минимум
32 символа и **разные**: access-токен, утёкший в логи прокси, не должен приниматься как refresh,
а секрет кодов сброса не должен зависеть от компрометации подписи токенов. Сгенерировать:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## Скрипты

| Команда | Назначение |
|---|---|
| `npm run start:dev` | Запуск в режиме watch |
| `npm run build` | Сборка в `dist/` |
| `npm run typecheck` | Проверка типов без эмита |
| `npm run lint` | ESLint (0 предупреждений) |
| `npm test` | Юнит-тесты |
| `npm run test:e2e` | E2E-тесты |
| `npm run prisma:migrate` | Создать/применить миграцию (dev) |
| `npm run prisma:deploy` | Применить миграции (prod) |

## Тесты

- **Юнит** (`npm test`) — рядом с кодом, `*.spec.ts`, внешняя инфраструктура не нужна.
- **E2E** (`npm run test:e2e`) — в `test/`:
  - `api-conventions.e2e-spec.ts`, `health-route.e2e-spec.ts` и `auth.e2e-spec.ts` работают
    **без** PostgreSQL и Redis: поднимается настоящее Nest-приложение с реальными глобальными
    pipe/filter/interceptor, а зависимости подменены заглушками (для Auth — репозиторий
    в памяти, так что сценарий «регистрация → вход → ротация → выход» проверяется на любой машине);
  - `health.e2e-spec.ts` требует поднятых PostgreSQL и Redis (запускается в CI
    и через `docker compose`).

## Структура

```
src/
  auth/        регистрация, вход, JWT с ротацией, сессии, сброс пароля, глобальный guard
  common/      формат ответа/ошибок, пагинация, Swagger-декораторы
  config/      валидация .env и типобезопасный доступ к настройкам
  health/      GET /health — живость приложения и зависимостей
  logger/      Pino: структурные логи с request-id
  mailer/      абстракция отправителя писем (провайдер подменяем)
  phone/       нормализация телефонов в E.164
  prisma/      подключение к PostgreSQL
  queue/       BullMQ: очереди фоновых задач
  redis/       общий клиент Redis (кэш, rate-limit)
prisma/        схема и миграции
test/          e2e-тесты (supertest)
```
