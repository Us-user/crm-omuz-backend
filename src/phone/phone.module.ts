import { Global, Module } from '@nestjs/common';

import { PhoneService } from './phone.service';

/**
 * Глобальный: нормализация телефонов нужна почти каждому доменному модулю
 * (студенты, сотрудники, лиды), а состояния у сервиса нет.
 */
@Global()
@Module({
  providers: [PhoneService],
  exports: [PhoneService],
})
export class PhoneModule {}
