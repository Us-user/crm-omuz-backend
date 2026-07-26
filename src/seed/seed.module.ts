import { Module } from '@nestjs/common';

import { PasswordService } from '../auth';
import { AppConfigModule } from '../config/config.module';
import { PhoneModule } from '../phone/phone.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RbacModule } from '../rbac/rbac.module';
import { AdminSeedRepository } from './admin-seed.repository';
import { AdminSeedService } from './admin-seed.service';

/**
 * Контекст для `npm run seed:admin` — собирается отдельно от `AppModule`
 * и **не** входит в него.
 *
 * Два следствия, ради которых так сделано:
 *   1. скрипту не нужны Redis и BullMQ, и он не должен падать из-за того,
 *      что очереди не подняты;
 *   2. `AppModule` не тянет провайдеры, у которых нет ни одного эндпоинта.
 *
 * `RbacModule` здесь обязателен: его `PermissionCatalogSyncService` при старте
 * контекста восстанавливает системную позицию `Director` со всем каталогом прав —
 * именно её скрипт и назначает. `PasswordService` объявлен провайдером напрямую,
 * а не через `AuthModule`: у него нет зависимостей, а модуль потянул бы Passport и JWT.
 */
@Module({
  imports: [AppConfigModule, PrismaModule, PhoneModule, RbacModule],
  providers: [PasswordService, AdminSeedRepository, AdminSeedService],
})
export class SeedModule {}
