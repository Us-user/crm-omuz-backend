import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus, AccountType, Locale } from '@prisma/client';

import { TOKEN_TYPE } from '../auth.constants';

/** Пара токенов в ответе. */
export class AuthTokensDto {
  @ApiProperty({ example: TOKEN_TYPE, description: 'Схема заголовка Authorization' })
  tokenType!: string;

  @ApiProperty({ description: 'Access-токен, живёт 1 час (ТЗ 3.1)' })
  accessToken!: string;

  @ApiProperty({ description: 'Refresh-токен, живёт 2 недели; при обновлении заменяется новым' })
  refreshToken!: string;

  @ApiProperty({ example: 3600, description: 'Время жизни access-токена, секунды' })
  expiresIn!: number;
}

/** Краткая карточка профиля (студента или сотрудника), привязанного к аккаунту. */
export class AuthProfileDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;
}

/** Аккаунт вызывающего — то, что клиенту нужно сразу после входа. */
export class AuthAccountDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '+992901234567', description: 'Логин в формате E.164' })
  phone!: string;

  @ApiProperty({ example: 'farrukh@example.tj' })
  email!: string;

  @ApiProperty({ enum: AccountType })
  type!: AccountType;

  @ApiProperty({ enum: AccountStatus })
  status!: AccountStatus;

  @ApiProperty({ enum: Locale })
  locale!: Locale;

  @ApiPropertyOptional({ type: AuthProfileDto, nullable: true })
  profile!: AuthProfileDto | null;
}

/** Ответ на регистрацию, вход и обновление токенов. */
export class AuthResponseDto {
  @ApiProperty({ type: AuthAccountDto })
  account!: AuthAccountDto;

  @ApiProperty({ type: AuthTokensDto })
  tokens!: AuthTokensDto;
}

/** Ответ на выход: сколько серверных сессий было погашено. */
export class LogoutResponseDto {
  @ApiProperty({ example: 1, description: 'Число отозванных сессий' })
  revokedSessions!: number;
}
