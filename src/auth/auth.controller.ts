import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { ApiDataResponse, ApiStandardErrors } from '../common';
import { AuthService } from './auth.service';
import type { AuthenticatedUser, RequestContext } from './auth.types';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { AuthResponseDto, LoginDto, LogoutResponseDto, RefreshTokenDto, RegisterDto } from './dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Регистрация студента',
    description:
      'Создаёт аккаунт с профилем студента и сразу выдаёт пару токенов. ' +
      'Подтверждение телефона или email не требуется (ТЗ 3.1).',
  })
  @ApiDataResponse(AuthResponseDto, { description: 'Аккаунт создан' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.CONFLICT)
  register(@Body() dto: RegisterDto, @Req() request: Request): Promise<AuthResponseDto> {
    return this.auth.register(dto, requestContext(request));
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Вход по номеру телефона и паролю' })
  @ApiDataResponse(AuthResponseDto, { description: 'Токены выданы' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  login(@Body() dto: LoginDto, @Req() request: Request): Promise<AuthResponseDto> {
    return this.auth.login(dto, requestContext(request));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Обновление пары токенов',
    description: 'Выдаёт новую пару и инвалидирует предъявленный refresh-токен (ротация, ТЗ 3.1).',
  })
  @ApiDataResponse(AuthResponseDto, { description: 'Выдана новая пара токенов' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  refresh(@Body() dto: RefreshTokenDto, @Req() request: Request): Promise<AuthResponseDto> {
    return this.auth.refresh(dto, requestContext(request));
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Выход с текущего устройства',
    description: 'Гасит серверную сессию, из которой выпущен предъявленный access-токен.',
  })
  @ApiDataResponse(LogoutResponseDto, { description: 'Сессия завершена' })
  @ApiStandardErrors(HttpStatus.UNAUTHORIZED)
  logout(@CurrentUser() user: AuthenticatedUser): Promise<LogoutResponseDto> {
    return this.auth.logout(user);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Выход со всех устройств' })
  @ApiDataResponse(LogoutResponseDto, { description: 'Все сессии аккаунта завершены' })
  @ApiStandardErrors(HttpStatus.UNAUTHORIZED)
  logoutAll(@CurrentUser() user: AuthenticatedUser): Promise<LogoutResponseDto> {
    return this.auth.logoutAll(user);
  }
}

/** Признаки клиента, сохраняемые в сессии, — чтобы позже показать список устройств. */
function requestContext(request: Request): RequestContext {
  const userAgent = request.get('user-agent');

  return {
    userAgent: userAgent?.slice(0, 255),
    ip: request.ip,
  };
}
