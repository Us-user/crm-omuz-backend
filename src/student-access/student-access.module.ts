import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { StudentAccessController } from './student-access.controller';
import { StudentAccessRepository } from './student-access.repository';
import { StudentAccessService } from './student-access.service';

/**
 * Доступ студента в систему (ТЗ 5.3: Invite / Block).
 *
 * Отдельный модуль, а не часть `StudentsModule`, — по той же причине, по которой
 * силлабус не вошёл в `CoursesModule` (сессия 0009): свой репозиторий и свои
 * правила, а наборам тестов карточки студента незачем подменять хранилище,
 * которым они не пользуются.
 *
 * `AuthModule` нужен ради `PasswordService` и `PasswordResetService`:
 * приглашение выпускает тот же одноразовый код, что и забытый пароль,
 * и второй реализации его жизненного цикла быть не должно.
 * `MailerService` и `PrismaService` — из глобальных модулей.
 */
@Module({
  imports: [AuthModule],
  controllers: [StudentAccessController],
  providers: [StudentAccessService, StudentAccessRepository],
})
export class StudentAccessModule {}
