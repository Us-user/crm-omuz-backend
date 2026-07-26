import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

import { trimString } from '../../common';
import { PASSWORD_MAX_LENGTH } from '../auth.constants';

/** Вход по номеру телефона и паролю (ТЗ 5.1). */
export class LoginDto {
  @ApiProperty({ example: '+992901234567', description: 'Логин — номер телефона' })
  @Transform(trimString)
  @IsString()
  @MinLength(5)
  @MaxLength(32)
  phone!: string;

  @ApiProperty({ example: 'очень-секретный-пароль' })
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}
