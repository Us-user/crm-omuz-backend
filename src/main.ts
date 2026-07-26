import 'reflect-metadata';

import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { API_PREFIX } from './constants';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = configureApp(app);

  await app.listen(config.port, '0.0.0.0');

  const logger = new NestLogger('Bootstrap');
  logger.log(`API слушает порт ${config.port} на префиксе /${API_PREFIX}`);
  if (config.swaggerEnabled) {
    logger.log(`Swagger: http://localhost:${config.port}/${API_PREFIX}/docs`);
  }
}

void bootstrap();
