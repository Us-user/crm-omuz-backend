import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

// Прямые пути, а не barrel `../audit`: тому нужен только декоратор, а barrel
// затянул бы правила журнала в модуль, который их не использует.
import { AuditAction } from '../audit/decorators/audit-action.decorator';
import { NoAudit } from '../audit/decorators/no-audit.decorator';
import { ApiDataResponse, ApiStandardErrors } from '../common';
import {
  LOGIN_RATE_LIMIT,
  PASSWORD_FORGOT_RATE_LIMIT,
  PASSWORD_RESET_RATE_LIMIT,
  RateLimit,
  REFRESH_RATE_LIMIT,
  REGISTER_RATE_LIMIT,
} from '../rate-limit';
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
  @RateLimit(REGISTER_RATE_LIMIT)
  // Прав каталога у входа нет по устройству: журналу имя действия задаётся
  // явно, а «кто» берётся из выданной карточки аккаунта.
  @AuditAction('Auth.Register')
  @ApiOperation({
    summary: 'Регистрация студента',
    description:
      'Создаёт аккаунт с профилем студента и сразу выдаёт пару токенов. ' +
      'Подтверждение телефона или email не требуется (ТЗ 3.1).',
  })
  @ApiDataResponse(AuthResponseDto, {
    description: 'Аккаунт создан',
    status: HttpStatus.CREATED,
  })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.CONFLICT, HttpStatus.TOO_MANY_REQUESTS)
  register(@Body() dto: RegisterDto, @Req() request: Request): Promise<AuthResponseDto> {
    return this.auth.register(dto, requestContext(request));
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @RateLimit(LOGIN_RATE_LIMIT)
  @AuditAction('Auth.Login')
  @ApiOperation({
    summary: 'Вход по номеру телефона и паролю',
    description:
      'Частота обращений ограничена по адресу и по номеру (ТЗ 3.8). Успешный вход ' +
      'обнуляет счётчик номера, поэтому пара опечаток подряд входа не закрывает.',
  })
  @ApiDataResponse(AuthResponseDto, { description: 'Токены выданы' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.TOO_MANY_REQUESTS,
  )
  login(@Body() dto: LoginDto, @Req() request: Request): Promise<AuthResponseDto> {
    return this.auth.login(dto, requestContext(request));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @RateLimit(REFRESH_RATE_LIMIT)
  // Единственный изменяющий запрос проекта, который действием не является:
  // пара токенов обновляется у каждого работающего человека раз в час
  // и говорит лишь о том, что вкладка не закрыта.
  @NoAudit()
  @ApiOperation({
    summary: 'Обновление пары токенов',
    description: 'Выдаёт новую пару и инвалидирует предъявленный refresh-токен (ротация, ТЗ 3.1).',
  })
  @ApiDataResponse(AuthResponseDto, { description: 'Выдана новая пара токенов' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.TOO_MANY_REQUESTS,
  )
  refresh(@Body() dto: RefreshTokenDto, @Req() request: Request): Promise<AuthResponseDto> {
    return this.auth.refresh(dto, requestContext(request));
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @AuditAction('Auth.Logout')
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
  @AuditAction('Auth.LogoutAll')
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
  @RateLimit(PASSWORD_FORGOT_RATE_LIMIT)
  // Действующее лицо здесь останется пустым: ответ одинаков независимо от того,
  // существует ли аккаунт, — и журнал не должен выдавать то, что скрывает ответ.
  @AuditAction('Auth.PasswordForgot')
  @ApiOperation({
    summary: 'Запрос кода восстановления пароля',
    description:
      `Отправляет на email ${String(PASSWORD_RESET_TTL_SECONDS / 60)}-минутный код из 6 цифр (ТЗ 3.1). ` +
      `Не более ${String(PASSWORD_RESET_MAX_REQUESTS_PER_HOUR)} запросов в час на аккаунт. ` +
      'Ответ одинаков независимо от того, существует ли аккаунт, — чтобы эндпоинт ' +
      'нельзя было использовать для проверки, кто зарегистрирован. Сверх этого ' +
      'частота обращений ограничена по адресу и по указанной почте (ТЗ 3.8); ' +
      '429 срабатывает на любом адресе почты и потому существования аккаунта не выдаёт.',
  })
  @ApiDataResponse(ForgotPasswordResponseDto, { description: 'Запрос принят' })
  @ApiStandardErrors(HttpStatus.BAD_REQUEST, HttpStatus.TOO_MANY_REQUESTS)
  forgotPassword(@Body() dto: ForgotPasswordDto): Promise<ForgotPasswordResponseDto> {
    return this.passwordReset.forgot(dto);
  }

  @Public()
  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  @RateLimit(PASSWORD_RESET_RATE_LIMIT)
  @AuditAction('Auth.PasswordReset')
  @ApiOperation({
    summary: 'Смена пароля по коду из письма',
    description:
      `Код одноразовый, действует ${String(PASSWORD_RESET_TTL_SECONDS / 60)} минут и гасится после ` +
      `${String(PASSWORD_RESET_MAX_ATTEMPTS)} неверных попыток. После смены пароля все сессии ` +
      'аккаунта отзываются — войти нужно заново.',
  })
  @ApiDataResponse(ResetPasswordResponseDto, { description: 'Пароль изменён' })
  @ApiStandardErrors(
    HttpStatus.BAD_REQUEST,
    HttpStatus.FORBIDDEN,
    HttpStatus.UNPROCESSABLE_ENTITY,
    HttpStatus.TOO_MANY_REQUESTS,
  )
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
