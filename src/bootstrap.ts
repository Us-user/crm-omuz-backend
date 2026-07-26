import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';

import { AppConfigService } from './config';
import { API_PREFIX, PREFIX_EXCLUDED_ROUTES } from './constants';
import { setupSwagger } from './swagger';

/**
 * Общая настройка приложения. Вынесена отдельно от `main.ts`, чтобы e2e-тесты
 * поднимали приложение ровно в той же конфигурации, что и прод.
 */
export function configureApp(app: INestApplication): AppConfigService {
  const config = app.get(AppConfigService);

  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX, { exclude: PREFIX_EXCLUDED_ROUTES });

  app.useGlobalPipes(
    new ValidationPipe({
      // Отсекаем лишние поля и запрещаем неизвестные — защита от «протаскивания» полей.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      validateCustomDecorators: true,
    }),
  );

  const corsOrigins = config.corsOrigins;
  if (corsOrigins.length > 0) {
    app.enableCors({ origin: corsOrigins, credentials: true });
  }

  if (config.swaggerEnabled) {
    setupSwagger(app);
  }

  app.enableShutdownHooks();

  return config;
}
