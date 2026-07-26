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

## Переменные окружения

Все переменные валидируются при старте (`src/config/env.validation.ts`); при некорректном
значении приложение не поднимется. Полный список с описанием — в `.env.example`.
Секреты хранятся только в `.env` (в git не попадает).

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
  - `api-conventions.e2e-spec.ts` и `health-route.e2e-spec.ts` работают **без** PostgreSQL
    и Redis: поднимается настоящее Nest-приложение с реальными глобальными
    pipe/filter/interceptor, а зависимости подменены заглушками;
  - `health.e2e-spec.ts` требует поднятых PostgreSQL и Redis (запускается в CI
    и через `docker compose`).

## Структура

```
src/
  common/      формат ответа/ошибок, пагинация, Swagger-декораторы
  config/      валидация .env и типобезопасный доступ к настройкам
  health/      GET /health — живость приложения и зависимостей
  logger/      Pino: структурные логи с request-id
  prisma/      подключение к PostgreSQL
  queue/       BullMQ: очереди фоновых задач
  redis/       общий клиент Redis (кэш, rate-limit)
prisma/        схема и миграции
test/          e2e-тесты (supertest)
```
