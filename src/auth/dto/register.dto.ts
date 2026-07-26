import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Locale } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { normalizeEmail, trimString } from '../../common';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth.constants';

/** Дата без времени: `YYYY-MM-DD`. Разбор часового пояса не нужен и только вредит. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Самостоятельная регистрация (ТЗ 3.1). Создаёт аккаунт типа `STUDENT`:
 * сотрудников заводит администратор (ТЗ 5.14), а не форма регистрации.
 */
export class RegisterDto {
  @ApiProperty({ example: 'Фаррух', maxLength: 100 })
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @ApiProperty({ example: 'Раҳимов', maxLength: 100 })
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;

  @ApiProperty({ example: '2004-05-12', description: 'Дата рождения в формате YYYY-MM-DD' })
  @Transform(trimString)
  @IsString()
  @Matches(ISO_DATE, { message: 'birthDate должен быть в формате YYYY-MM-DD' })
  birthDate!: string;

  @ApiProperty({ example: 'г. Душанбе, ул. Рудаки, 25', maxLength: 300 })
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  address!: string;

  @ApiProperty({ example: 'farrukh@example.tj' })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({
    example: '+992901234567',
    description: 'Логин. Принимается в любом виде, хранится в E.164.',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(5)
  @MaxLength(32)
  phone!: string;

  @ApiPropertyOptional({
    example: '+992907654321',
    description: 'Телефон родителя/опекуна. Не обязателен: студент может быть совершеннолетним.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(32)
  parentPhone?: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiPropertyOptional({
    enum: Locale,
    default: Locale.RU,
    description: 'Язык уведомлений (ТЗ 3.3)',
  })
  @IsOptional()
  @IsEnum(Locale)
  locale?: Locale;
}
