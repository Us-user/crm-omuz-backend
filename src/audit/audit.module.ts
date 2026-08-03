import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AdminLogsController } from './admin-logs.controller';
import { AdminLogsService } from './admin-logs.service';
import { AuditContextGuard } from './audit-context.guard';
import { AuditRecorder } from './audit-recorder.service';
import { AuditInterceptor } from './audit.interceptor';
import { AuditRepository } from './audit.repository';

/**
 * Аудит действий (ТЗ 3.6) и экран `Administration → Logs` (ТЗ 5.15).
 *
 * Guard и перехватчик регистрируются **здесь**, а не в `AppModule`: `APP_GUARD`
 * и `APP_INTERCEPTOR` из любого модуля действуют глобально, а зависимости
 * при этом разрешаются в своём модуле. Побочная выгода — критерий сессии 0006:
 * наборы e2e, которым журнал не нужен, просто не импортируют этот модуль
 * и не подменяют его репозиторий.
 *
 * **Порядок важен ровно один раз:** глобальные guard'ы выполняются в порядке
 * регистрации, и `AuditModule` обязан стоять в `AppModule` **раньше**
 * `AuthModule` — иначе `JwtAuthGuard` отклонил бы запрос без токена прежде,
 * чем журнал успел подписаться на ответ, и «кто ломился в закрытый эндпоинт»
 * в него не попало бы. На это есть e2e-тест.
 *
 * `PrismaService` — из глобального модуля.
 */
@Module({
  controllers: [AdminLogsController],
  providers: [
    AdminLogsService,
    AuditRecorder,
    AuditRepository,
    { provide: APP_GUARD, useClass: AuditContextGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AuditModule {}
