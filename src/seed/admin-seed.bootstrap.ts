import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { AppConfigService } from '../config';
import { AdminSeedError, AdminSeedService } from './admin-seed.service';

/**
 * Заведение первого руководителя при старте приложения (ТЗ 3.2, решение 0007).
 *
 * **Зачем понадобилось сверх `npm run seed:admin`.** Скрипт запускает тот,
 * у кого есть доступ к серверу, — но на бесплатных площадках (Render) shell
 * недоступен вовсе, и завести первого `Director` было бы нечем: регистрация
 * создаёт только студентов, а раздача ролей требует прав, которых на пустой
 * базе нет ни у кого. То есть без этого CRM на таком деплое недоступна никому.
 *
 * **Почему это не «эндпоинт первичной настройки».** Довод сессии 0007 в силе:
 * публичный путь к правам `Director` пришлось бы охранять, и он остался бы
 * в приложении навсегда. Здесь новых возможностей не появляется — данные
 * задаёт тот, кто и так управляет окружением сервиса.
 *
 * Три свойства, без которых так делать было бы нельзя:
 *   1. **идемпотентность** — существующий аккаунт не трогается, пароль
 *      не меняется (`AdminSeedService.attachToExisting`), поэтому перезапуски
 *      и переезды безопасны;
 *   2. **сбой не роняет приложение** — API поднимается и без руководителя,
 *      а причина уходит в лог: упавший старт лечить труднее, чем прочитать
 *      ошибку (приём `ScheduledTasksRegistrar`, 0037);
 *   3. **пароль не попадает в лог** — ни заданный, ни сгенерированный.
 *      Сгенерированный здесь бесполезен: показать его некому, поэтому
 *      на площадке без shell пароль **обязателен**, и об этом говорится прямо.
 */
@Injectable()
export class AdminSeedBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminSeedBootstrap.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly seeder: AdminSeedService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.isTest) return;

    const input = this.config.seedAdmin;
    if (!input) {
      // Наполовину заполненный набор — почти наверняка забытая переменная,
      // и промолчать здесь значило бы оставить площадку без способа войти.
      if (this.config.seedAdminPartiallyConfigured) {
        this.logger.warn(
          'Первый руководитель не заведён: заданы не все переменные SEED_ADMIN_* ' +
            '(нужны PHONE, EMAIL, FIRST_NAME, LAST_NAME)',
        );
      }

      return;
    }

    if (!input.password) {
      // Скрипт в такой ситуации печатает сгенерированный пароль в stdout,
      // но здесь его читателя нет: писать пароль в журнал сервиса нельзя
      // (тот же довод, по которому письма уходят на уровне `debug`, 0003).
      this.logger.error(
        'Первый руководитель не заведён: не задан SEED_ADMIN_PASSWORD. ' +
          'При старте приложения пароль не генерируется — показать его было бы негде',
      );

      return;
    }

    try {
      const result = await this.seeder.seed(input);

      this.logger.log(
        result.accountCreated
          ? `Заведён первый руководитель: ${result.phone} (аккаунт ${result.accountId})`
          : `Руководитель ${result.phone} уже существовал — пароль не менялся`,
      );

      if (result.roleAssigned && !result.accountCreated) {
        this.logger.log('Позиция Director досогласована существующему аккаунту');
      }
    } catch (error: unknown) {
      const reason = error instanceof AdminSeedError ? error.message : messageOf(error);
      this.logger.error(`Не удалось завести первого руководителя: ${reason}`);
    }
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
