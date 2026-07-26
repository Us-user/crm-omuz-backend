import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Выполняется до импорта модулей приложения: `ConfigModule.forRoot()` валидирует
// окружение прямо в момент импорта, поэтому значения должны быть готовы заранее.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

// Если локального `.env` нет (например, в CI) — подставляем заглушку, чтобы тесты,
// не работающие с БД, поднимались без внешней конфигурации.
const hasEnvFile = existsSync(resolve(__dirname, '..', '.env'));
if (!hasEnvFile) {
  process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/crm_omuz_test?schema=public';
}
