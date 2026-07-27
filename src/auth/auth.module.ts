import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { JWT_ACCESS_STRATEGY } from './auth.constants';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PasswordService } from './password.service';
import { PasswordResetService } from './password-reset.service';
import { ResetCodeService } from './reset-code.service';
import { JwtAccessStrategy } from './strategies/jwt-access.strategy';
import { TokenService } from './token.service';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: JWT_ACCESS_STRATEGY, session: false }),
    // Секреты передаются на каждую подпись отдельно (access и refresh разные),
    // поэтому глобальной конфигурации у модуля нет.
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRepository,
    PasswordService,
    PasswordResetService,
    ResetCodeService,
    TokenService,
    JwtAccessStrategy,
    // Глобально: по умолчанию защищён каждый эндпоинт, открывается через `@Public()` (ТЗ 3.8).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  // `PasswordResetService` наружу нужен приглашению студента (ТЗ 5.3): оно выпускает
  // тот же одноразовый код, и вторая реализация его жизненного цикла разошлась бы
  // с этой по сроку, подписи и правилу «живой код ровно один».
  exports: [PasswordService, PasswordResetService, TokenService],
})
export class AuthModule {}
