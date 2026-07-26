import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { ISO_DATE_PATTERN, trimString } from '../../common';

/**
 * Перевод студента в сотрудники (ТЗ 3.1: выпускник → ментор).
 *
 * Все поля необязательны: профиль сотрудника собирается из профиля студента,
 * а тело запроса лишь дополняет его тем, чего у студента не было (ТЗ 5.14).
 * Позиции (`Position`) назначаются отдельно — каталог прав появится в Фазе 2.
 */
export class PromoteStudentDto {
  @ApiPropertyOptional({ example: 'Саидович', maxLength: 100, description: 'Отчество' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  middleName?: string;

  @ApiPropertyOptional({
    example: '+992937654321',
    description:
      'Рабочий телефон сотрудника. По умолчанию берётся контактный телефон студента. ' +
      'На логин не влияет: логином остаётся телефон аккаунта (ТЗ 3.1).',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MinLength(5)
  @MaxLength(32)
  phone?: string;

  @ApiPropertyOptional({ example: '2 года наставничества в группах Frontend', maxLength: 1000 })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(1000)
  experience?: string;

  @ApiPropertyOptional({
    example: 'Выпускник курса Frontend, переведён в менторы',
    maxLength: 2000,
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({
    example: '2026-08-01',
    description: 'Дата приёма на работу в формате YYYY-MM-DD. По умолчанию — сегодня.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(ISO_DATE_PATTERN, { message: 'hiredAt должен быть в формате YYYY-MM-DD' })
  hiredAt?: string;
}
