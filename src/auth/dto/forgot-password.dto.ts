import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

import { normalizeEmail } from '../../common';

/** Запрос кода восстановления пароля (ТЗ 5.1). */
export class ForgotPasswordDto {
  @ApiProperty({
    example: 'farrukh@example.tj',
    description: 'Email аккаунта. Регистр и пробелы не важны.',
  })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
