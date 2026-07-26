# Сессия 0001 — Фаза 0: каркас приложения и сквозные конвенции API

- **Дата:** 2026-07-26
- **Фаза roadmap:** Фаза 0 — Фундамент и инфраструктура
- **Статус сессии:** завершена

## Цель сессии
Развернуть каркас бэкенда: NestJS + TypeScript (strict), конфигурация окружения,
подключения к PostgreSQL/Redis, сквозные конвенции API (`{ data, meta }` / `{ error }`,
пагинация, ValidationPipe), Swagger, `GET /health`, логирование и тестовый каркас.

## Что сделано

### Каркас и сборка
- `package.json`, `tsconfig.json` (strict + `noUnusedLocals/Parameters`, `noImplicitOverride`),
  `tsconfig.build.json`, `nest-cli.json` со Swagger-плагином.
- ESLint (flat config, typed rules) + Prettier; `npm run lint` идёт с `--max-warnings 0`.
- `Dockerfile` (многостадийный: builder → prod-deps → runner под пользователем `node`)
  и `docker-compose.yml` (postgres 16 + redis 7 + app, healthcheck'и, `migrate deploy` перед стартом).
- `.github/workflows/ci.yml`: lint → typecheck → unit → migrate deploy → e2e на сервисах postgres/redis.
- `README.md` с конвенциями API, переменными окружения и структурой проекта.

### Конфигурация (`src/config`)
- `env.validation.ts` — схема `.env` на class-validator: приложение **не стартует**
  при некорректной конфигурации (ТЗ 3.8). Пустая строка трактуется как «не задано» → берётся дефолт.
- `AppConfigService` — типобезопасный доступ к настройкам; `process.env` больше нигде не читается.
- `.env.example` со всеми переменными; `.env` в `.gitignore`.

### Инфраструктурные модули
- `src/prisma` — `PrismaService` (connect/disconnect по жизненному циклу Nest, `ping()` для health).
- `src/redis` — общий клиент ioredis (кэш и rate-limit Фазы 14), с бэкоффом и без «затопления» логов.
- `src/queue` — BullMQ: root-конфигурация (3 попытки, экспоненциальный backoff, автоочистка)
  и очередь `notifications` с базовым процессором-заглушкой под Фазу 11.
- `src/logger` — Pino: `x-request-id` (генерируется или переиспользуется входящий),
  redact для `authorization`/`cookie`/`password`/`refreshToken`, `/health` не засоряет лог.

### Сквозные конвенции API (`src/common`)
- `TransformResponseInterceptor` → всё приводится к `{ data }`, `Paginated` → `{ data, meta }`.
- `AllExceptionsFilter` → единый `{ error: { code, message, details, requestId, timestamp } }`;
  маппинг Nest-исключений и ошибок Prisma (P2002 → 409, P2003 → 409, P2025 → 404);
  5xx логируются со стектрейсом, но наружу отдаётся обезличенное сообщение.
- `ErrorCode` — коды `VALIDATION_ERROR / UNAUTHORIZED / FORBIDDEN / NOT_FOUND / CONFLICT /
  UNPROCESSABLE_ENTITY / TOO_MANY_REQUESTS / INTERNAL_ERROR`.
- `BusinessRuleException` → 422 для нарушений бизнес-правил.
- `PaginationQueryDto` (`page`/`limit`=20/max 100, `search`, `sort`, `order`) + геттеры `skip`/`take` под Prisma.
- Swagger-декораторы `ApiDataResponse` / `ApiPaginatedResponse` / `ApiStandardErrors`.
- `src/bootstrap.ts` — общая настройка приложения, чтобы e2e поднимал ровно ту же конфигурацию, что и прод.

### Health и Swagger
- `GET /health` — статус приложения + БД + Redis, `up`/`degraded`, время ответа каждой проверки.
- Swagger на `/api/v1/docs`, JSON — `/api/v1/docs/json`.

### Prisma
- `prisma/schema.prisma` (datasource + generator, доменные модели — с Фазы 1).
- `prisma/migrations/20260726000000_init/` — первая (пустая) миграция: создаёт историю миграций
  и расширение `pgcrypto`.

## Принятые решения
- **`GET /health` вынесен из префикса `/api/v1`** — служебный эндпоинт для мониторинга не версионируется.
- **`src/config/index.ts` НЕ реэкспортирует `config.module`.** `ConfigModule.forRoot()` вычисляется
  в момент импорта и сразу валидирует окружение — из-за этого юнит-тест сервиса падал, требуя `.env`.
  Barrel отдаёт только сервис и схему; модуль импортируется по прямому пути.
- **Ошибка 500 не раскрывает внутренности** — наружу «Внутренняя ошибка сервера»,
  подробности только в лог (есть тест на утечку текста исключения).
- **`error.requestId` = заголовок `x-request-id` = `req.id` в логах** — сквозная трассировка запроса.
- **Расширение формата ошибки** относительно ТЗ 3.5: к `{ code, message, details }` добавлены
  `requestId` и `timestamp` — не ломает контракт, сильно помогает поддержке.
- **E2E разделены на два вида:** не требующие инфраструктуры (конвенции API, маршрут `/health`
  с заглушками) и требующие реальных PostgreSQL/Redis (для CI и docker compose).
  Так основная часть Фазы 0 проверяема на любой машине.
- **Уровень лога `silent`** добавлен в схему окружения — нужен тестам.

## Проверка
Выполнено и зелёное:
- `npm run lint` — 0 ошибок, 0 предупреждений;
- `npx tsc --noEmit` — чисто;
- `npm run build` — сборка проходит;
- `npm test` — **26 юнит-тестов** (валидация окружения, пагинация, интерцептор, фильтр ошибок, health-сервис);
- `npm run test:e2e` (наборы без инфраструктуры) — **17 тестов**: формат `{data}`/`{data,meta}`,
  дефолты пагинации, префикс `/api/v1`, коды 400/404/422/500, `forbidNonWhitelisted`,
  OpenAPI-документ, `x-request-id`, маршрут `/health` в состояниях `up` и `degraded`.

**Найдено тестом и исправлено:** в Swagger был лишний `.addServer('/api/v1')` при том, что пути
документа уже содержат глобальный префикс — «Try it out» бил бы в `/api/v1/api/v1/...`.

**НЕ проверено (честно):**
- Миграция **не применена** — пароль локального PostgreSQL неизвестен (найдены инстансы
  PG 18 на порту 5433 и PG 17 на 5434, стандартные пароли не подошли; пользователь выбрал пропустить).
- `test/health.e2e-spec.ts` (реальные PostgreSQL/Redis) **не запускался**.
- Redis/BullMQ **не проверены вживую** — Redis локально не запущен, Docker не установлен.
- `docker compose` **не проверен** — Docker недоступен в этом окружении.
- CI-workflow **не прогонялся** — первый запуск состоится на GitHub после пуша.

## Не доделано / известные проблемы
- В `.env` (локальный, не в git) стоит плейсхолдер `ЗАМЕНИТЕ_ПАРОЛЬ` в `DATABASE_URL` —
  до его замены приложение не поднимется и миграция не применится.
- Redis недоступен → `GET /health` вернёт `degraded` (это ожидаемое поведение, не баг).

## Следующий шаг
1. Подставить пароль в `DATABASE_URL`, выполнить `npx prisma migrate deploy` и прогнать
   `npm run test:e2e` целиком — это закроет `[~]`-пункты Фазы 0.
2. Начать **Фазу 1 (Auth)**: Prisma-модели `Account`, `Student`, `Employee`, `Session`,
   argon2id, нормализация телефона в E.164, `POST /auth/register` и `POST /auth/login`.

## Коммит
- `780a489` — «Фаза 0: каркас NestJS, конвенции API, health, Docker и CI»
  (60 файлов, запушено в `main` → https://github.com/Us-user/crm-omuz-backend).
