import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { normalizeEmail, trimString } from '../../common';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RESET_CODE_LENGTH,
} from '../auth.constants';

const CODE_PATTERN = new RegExp(`^\\d{${PASSWORD_RESET_CODE_LENGTH}}$`);

/**
 * Установка нового пароля по коду из письма (ТЗ 5.1).
 * Email в теле обязателен: без него код пришлось бы искать по всей таблице,
 * и 10^6 вариантов подбирались бы против любого аккаунта сразу.
 */
export class ResetPasswordDto {
  @ApiProperty({ example: 'farrukh@example.tj', description: 'Email, на который пришёл код' })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({
    example: '482915',
    description: `Код из письма: ${String(PASSWORD_RESET_CODE_LENGTH)} цифр, действует 10 минут`,
  })
  @Transform(trimString)
  @IsString()
  @Matches(CODE_PATTERN, {
    message: `code должен состоять из ${String(PASSWORD_RESET_CODE_LENGTH)} цифр`,
  })
  code!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;
}
