import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { ISO_DATE_PATTERN, trimString } from '../../common';

export const MIN_CERTIFICATE_SERIAL_LENGTH = 3;
export const MAX_CERTIFICATE_SERIAL_LENGTH = 64;

/**
 * Выдача сертификата (ТЗ 5.11: «Serial, Certificate (флаг+PDF), Date of Issue»;
 * ТЗ 3.7: «серийный №»).
 *
 * Номер **приходит извне и обязателен**: своей нумерации сертификатов у системы
 * нет, а придумать её значило бы зашить в данные схему, которой ТЗ не задаёт
 * (и получить гонку на счётчике). Центр нумерует дипломы сам, а система
 * следит, чтобы номер был один на весь центр (409 на занятый).
 *
 * Сам PDF здесь не рождается: генерация по шаблону — Фаза 12
 * (`GET /graduates/{id}/certificate/export`). Выдача — это факт, а не файл.
 */
export class IssueCertificateDto {
  @ApiProperty({
    example: 'OMZ-2026-000148',
    minLength: MIN_CERTIFICATE_SERIAL_LENGTH,
    maxLength: MAX_CERTIFICATE_SERIAL_LENGTH,
    description: 'Серийный номер сертификата. Уникален по всему центру.',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(MIN_CERTIFICATE_SERIAL_LENGTH)
  @MaxLength(MAX_CERTIFICATE_SERIAL_LENGTH)
  serial!: string;

  @ApiPropertyOptional({
    example: '2026-07-05',
    description: 'Дата выдачи. По умолчанию — сегодня.',
  })
  @IsOptional()
  @Matches(ISO_DATE_PATTERN, { message: 'issuedAt: ожидается дата в формате YYYY-MM-DD' })
  issuedAt?: string;
}
