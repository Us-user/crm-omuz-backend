import { Module } from '@nestjs/common';

import { AvansModule } from '../avans/avans.module';
import { MentorCabinetController } from './mentor-cabinet.controller';
import { MentorCabinetRepository } from './mentor-cabinet.repository';
import { MentorCabinetService } from './mentor-cabinet.service';

/**
 * Кабинет ментора (ТЗ 5.4). Отдельный модуль по тому же критерию, что действует
 * с сессии 0006: свой репозиторий и свои правила — и наборам тестов админ-стороны
 * не приходится подменять хранилище, которым они не пользуются.
 * `PrismaService` — из глобального модуля.
 *
 * `AvansModule` — единственная внешняя зависимость: подача заявки о себе (ТЗ 5.4)
 * это тот же сценарий, что на админ-стороне, только адресованный от токена.
 * Через границу модуля переходит **сервис**, а не чистая функция, — как
 * у кабинета студента с расчётом успеваемости (сессия 0020): правила «одна
 * нерассмотренная заявка» и «рассмотренная не отзывается» касаются денег,
 * и второй их экземпляр разошёлся бы с первым молча.
 */
@Module({
  imports: [AvansModule],
  controllers: [MentorCabinetController],
  providers: [MentorCabinetService, MentorCabinetRepository],
})
export class MentorCabinetModule {}
