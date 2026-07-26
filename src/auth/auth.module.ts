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
    TokenService,
    JwtAccessStrategy,
    // Глобально: по умолчанию защищён каждый эндпоинт, открывается через `@Public()` (ТЗ 3.8).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [PasswordService, TokenService],
})
export class AuthModule {}
