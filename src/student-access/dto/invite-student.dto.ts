import { ApiPropertyOptional } from '@nestjs/swagger';
import { Locale } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { normalizeEmail } from '../../common';

/**
 * Приглашение студента (ТЗ 5.3: «аккаунт опционален, Invite»).
 *
 * Пароля здесь нет и не будет: аккаунт заводится с непригодным для входа
 * секретом, а студент задаёт свой пароль по одноразовому коду из письма.
 * Логин задавать тоже нечем — им становится контактный телефон профиля (ТЗ 3.1).
 */
export class InviteStudentDto {
  @ApiPropertyOptional({
    example: 'nigina@mail.tj',
    maxLength: 200,
    description:
      'Почта для приглашения. Если не передана — берётся из карточки студента; ' +
      'переданная заодно записывается в карточку, чтобы адрес логина и адрес ' +
      'в профиле не разошлись.',
  })
  @IsOptional()
  @Transform(normalizeEmail)
  @IsString()
  @MaxLength(200)
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    enum: Locale,
    default: Locale.RU,
    description: 'Язык письма и интерфейса студента (ТЗ 3.3).',
  })
  @IsOptional()
  @IsEnum(Locale)
  locale?: Locale;
}
