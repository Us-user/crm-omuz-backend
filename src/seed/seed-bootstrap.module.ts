import { Module } from '@nestjs/common';

import { PasswordService } from '../auth';
import { AdminSeedBootstrap } from './admin-seed.bootstrap';
import { AdminSeedRepository } from './admin-seed.repository';
import { AdminSeedService } from './admin-seed.service';

/**
 * Заведение первого руководителя при старте `AppModule` — для площадок
 * без доступа к shell, где `npm run seed:admin` запустить нечем.
 *
 * Отдельный модуль, а не `SeedModule`: тот собирается для CLI-скрипта своим
 * контекстом и **явно** тянет `PrismaModule`, `PhoneModule` и `RbacModule`,
 * потому что вне `AppModule` глобальных модулей не существует. Здесь все три
 * уже глобальны, а `OnApplicationBootstrap` скрипту не нужен — иначе он
 * сеял бы дважды: один раз по окружению, второй раз по аргументам.
 *
 * `AdminSeedService` при этом **один на оба пути** — второй экземпляр правил
 * заведения руководителя разошёлся бы с первым молча (довод кабинета ментора
 * про `AvansService`, 0023).
 *
 * **Порядок в `AppModule`:** модуль стоит после `RbacModule`, потому что
 * `onApplicationBootstrap` выполняется в порядке регистрации, а позицию
 * `Director` восстанавливает синхронизация каталога прав. На чистой базе
 * позицию заводит миграция, то есть до старта приложения, — поэтому
 * зависимость здесь мягкая (в отличие от жёсткой «журнал раньше auth», 0038):
 * нарушение порядка проявилось бы только на базе, где позицию удалили,
 * и стоило бы одной строки ошибки в логе, а не потери данных.
 */
@Module({
  providers: [PasswordService, AdminSeedRepository, AdminSeedService, AdminSeedBootstrap],
})
export class SeedBootstrapModule {}
