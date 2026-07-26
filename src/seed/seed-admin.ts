import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import type { SeedAdminInput } from './admin-seed.service';
import { AdminSeedError, AdminSeedService } from './admin-seed.service';
import { SeedModule } from './seed.module';

/**
 * `npm run seed:admin` — заводит первого руководителя (позиция `Director`).
 *
 * Значения берутся из аргументов, а недостающие — из переменных окружения
 * `SEED_ADMIN_*`. Пароль необязателен: без него скрипт сгенерирует случайный
 * и покажет один раз — так он не осядет в истории команд.
 *
 *   npm run seed:admin -- --phone=+992901234567 --email=director@omuz.tj \
 *                         --first-name=Фаррух --last-name=Раҳимов
 *
 * Повторный запуск безопасен: существующий аккаунт не меняется, скрипт лишь
 * досогласовывает позицию `Director`.
 */

const USAGE = `
Заведение первого руководителя CRM «Omuz».

  npm run seed:admin -- --phone=<E.164> --email=<email> --first-name=<имя> --last-name=<фамилия>

Аргументы (или переменные окружения):
  --phone        SEED_ADMIN_PHONE        телефон-логин, приводится к E.164
  --email        SEED_ADMIN_EMAIL        email для сброса пароля
  --first-name   SEED_ADMIN_FIRST_NAME   имя
  --last-name    SEED_ADMIN_LAST_NAME    фамилия
  --middle-name  SEED_ADMIN_MIDDLE_NAME  отчество (необязательно)
  --password     SEED_ADMIN_PASSWORD     пароль ≥8 символов; без него будет сгенерирован
`;

/** Разбирает `--ключ=значение`; форма `--ключ значение` намеренно не поддержана. */
function parseArgs(argv: readonly string[]): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const arg of argv) {
    const match = /^--([\w-]+)=(.*)$/.exec(arg);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      parsed[match[1]] = match[2];
    }
  }

  return parsed;
}

function readInput(args: Record<string, string>): SeedAdminInput {
  const pick = (flag: string, envKey: string): string | undefined =>
    args[flag] ?? process.env[envKey] ?? undefined;

  const required = (flag: string, envKey: string): string => {
    const value = pick(flag, envKey)?.trim();
    if (value === undefined || value === '') {
      throw new AdminSeedError(`Не задан --${flag} (или ${envKey})`);
    }

    return value;
  };

  return {
    phone: required('phone', 'SEED_ADMIN_PHONE'),
    email: required('email', 'SEED_ADMIN_EMAIL'),
    firstName: required('first-name', 'SEED_ADMIN_FIRST_NAME'),
    lastName: required('last-name', 'SEED_ADMIN_LAST_NAME'),
    middleName: pick('middle-name', 'SEED_ADMIN_MIDDLE_NAME'),
    password: pick('password', 'SEED_ADMIN_PASSWORD'),
  };
}

async function main(): Promise<void> {
  const logger = new Logger('SeedAdmin');
  const args = parseArgs(process.argv.slice(2));

  if ('help' in args || process.argv.includes('--help')) {
    process.stdout.write(USAGE);
    return;
  }

  const input = readInput(args);

  // `createApplicationContext` вызывает `init()`, а значит и `onApplicationBootstrap`:
  // синхронизация каталога заводит позицию `Director` со всеми правами до того,
  // как скрипт попробует её назначить.
  const app = await NestFactory.createApplicationContext(SeedModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const result = await app.get(AdminSeedService).seed(input);

    logger.log(
      result.accountCreated
        ? `Создан руководитель: аккаунт ${result.accountId}, профиль ${result.employeeId}`
        : `Аккаунт с телефоном ${result.phone} уже существовал — пароль не менялся`,
    );
    logger.log(`Логин: ${result.phone} · email: ${result.email}`);
    logger.log(
      result.roleAssigned ? 'Позиция Director назначена' : 'Позиция Director уже была назначена',
    );

    if (result.generatedPassword !== undefined) {
      // Единственное место, где пароль виден. В лог приложения он не пишется:
      // это stdout запустившего скрипт, а не журнал сервиса.
      process.stdout.write(`\nПароль (показывается один раз): ${result.generatedPassword}\n\n`);
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  const logger = new Logger('SeedAdmin');

  if (error instanceof AdminSeedError) {
    logger.error(error.message);
    process.stdout.write(USAGE);
  } else {
    logger.error(error instanceof Error ? error.message : String(error));
  }

  process.exitCode = 1;
});
