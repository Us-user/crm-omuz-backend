import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

import { AuditOutcome } from '../audit';

/**
 * Кто совершил действие. Имя, телефон и тип — **снимок** на момент действия:
 * ссылка на аккаунт после его удаления обнуляется, а строка журнала обязана
 * остаться читаемой.
 */
export class AuditActorDto {
  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'Аккаунт, если он ещё есть' })
  accountId!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Фаррух Раҳимов' })
  name!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '+992901234567' })
  phone!: string | null;

  @ApiPropertyOptional({ enum: AccountType, nullable: true })
  type!: AccountType | null;
}

/** Строка журнала действий (ТЗ 3.6). */
export class AuditLogDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: AuditActorDto })
  actor!: AuditActorDto;

  @ApiProperty({ example: 'Students.Create', description: 'Что сделали' })
  action!: string;

  @ApiProperty({ example: 'POST' })
  method!: string;

  @ApiProperty({ example: '/api/v1/students/:id', description: 'Шаблон маршрута, не адрес' })
  path!: string;

  @ApiPropertyOptional({ nullable: true, description: 'Над чем: идентификатор объекта действия' })
  entityId!: string | null;

  @ApiProperty({ example: 201 })
  statusCode!: number;

  @ApiProperty({ enum: AuditOutcome, description: 'Выводится из кода ответа, не хранится' })
  outcome!: AuditOutcome;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Тот же `x-request-id`, что в логах приложения и в теле ошибки',
  })
  requestId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  ip!: string | null;

  @ApiPropertyOptional({ nullable: true })
  userAgent!: string | null;

  @ApiProperty({ description: 'Когда', format: 'date-time' })
  createdAt!: string;
}
