import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { ApiDataResponse, ApiStandardErrors } from '../common';
import {
  PASSWORD_RESET_MAX_ATTEMPTS,
  PASSWORD_RESET_MAX_REQUESTS_PER_HOUR,
  PASSWORD_RESET_TTL_SECONDS,
} from './auth.constants';
import { AuthService } from './auth.service';
import type { AuthenticatedUser, RequestContext } from './auth.types';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import {
  AuthResponseDto,
  ForgotPasswordDto,
  ForgotPasswordResponseDto,
  LoginDto,
  LogoutResponseDto,
  RefreshTokenDto,
  RegisterDto,
  ResetPasswordDto,
  ResetPasswordResponseDto,
} from './dto';
import { PasswordResetService } from './password-reset.service';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly passwordReset: PasswordResetService,
  ) {}

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

  @Public()
  @Post('password/forgot')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Запрос кода восстановления пароля',
    description:
      `Отправляет на email ${String(PASSWORD_RESET_TTL_SECONDS / 60)}-минутный код из 6 цифр (ТЗ 3.1). ` +
      `Не более ${String(PASSWORD_RESET_MAX_REQUESTS_PER_HOUR)} запросов в час на аккаунт. ` +
      'Ответ одинаков независимо от того, существует ли аккаунт, — чтобы эндпоинт ' +
      'нельзя было использовать для проверки, кто зарегистрирован.',
  })
  @ApiDataResponse(ForgotPasswordResponseDto, { description: 'Запрос принят' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST)
  forgotPassword(@Body() dto: ForgotPasswordDto): Promise<ForgotPasswordResponseDto> {
    return this.passwordReset.forgot(dto);
  }

  @Public()
  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Смена пароля по коду из письма',
    description:
      `Код одноразовый, действует ${String(PASSWORD_RESET_TTL_SECONDS / 60)} минут и гасится после ` +
      `${String(PASSWORD_RESET_MAX_ATTEMPTS)} неверных попыток. После смены пароля все сессии ` +
      'аккаунта отзываются — войти нужно заново.',
  })
  @ApiDataResponse(ResetPasswordResponseDto, { description: 'Пароль изменён' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.FORBIDDEN, HttpStatus.UNPROCESSABLE_ENTITY)
  resetPassword(@Body() dto: ResetPasswordDto): Promise<ResetPasswordResponseDto> {
    return this.passwordReset.reset(dto);
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
