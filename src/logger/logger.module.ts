import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

import { AppConfigService } from '../config';
import { AppConfigModule } from '../config/config.module';

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Структурированное логирование Pino (ТЗ 3.6): у каждой строки лога есть `req.id`,
 * по нему запрос сопоставляется с `error.requestId` из ответа API.
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.logLevel,
          // Человекочитаемый вывод только в дев-режиме: в проде — JSON,
          // в тестах — без отдельного worker-потока pino-pretty.
          transport:
            config.isProduction || config.isTest
              ? undefined
              : {
                  target: 'pino-pretty',
                  options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l' },
                },
          genReqId: (req: IncomingMessage, res: ServerResponse): string => {
            const existing = req.headers[REQUEST_ID_HEADER];
            const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
            res.setHeader(REQUEST_ID_HEADER, id);
            return id;
          },
          // Секреты и персональные данные не должны попадать в логи (ТЗ 3.8).
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.body.password',
              'req.body.newPassword',
              'req.body.refreshToken',
              'res.headers["set-cookie"]',
            ],
            censor: '[скрыто]',
          },
          autoLogging: {
            ignore: (req: IncomingMessage) => req.url === '/health',
          },
          quietReqLogger: true,
        },
      }),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
