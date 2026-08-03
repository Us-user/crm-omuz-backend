import { ApiPropertyOptional } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

import { ISO_DATE_PATTERN, PaginationQueryDto, SortOrder } from '../../common';
import { AuditOutcome } from '../audit';

/**
 * Журнал действий (ТЗ 5.15 «Logs — аудит по датам»).
 *
 * Поля сортировки нет: у журнала осмыслен один порядок — по времени, и выбор
 * между «по коду ответа» и «по пути» был бы параметром, который есть
 * в OpenAPI и ничего не значит (довод `PageQueryDto`, 0021).
 */
export class AuditLogQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: SortOrder,
    default: SortOrder.Desc,
    description: 'Порядок по времени действия. Свежие сверху по умолчанию.',
  })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Действия одного аккаунта. Удалённый аккаунт по ссылке уже не ищется — ' +
      'его действия остаются в журнале со снимком имени и находятся через `search`.',
  })
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @ApiPropertyOptional({ enum: AccountType, description: 'Тип действующего лица (снимок).' })
  @IsOptional()
  @IsEnum(AccountType)
  actorType?: AccountType;

  @ApiPropertyOptional({
    example: 'Students.Create',
    description: 'Точный код действия — право каталога без префикса `Permission.`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  action?: string;

  @ApiPropertyOptional({
    description: 'Всё, что делали с одной записью: идентификатор объекта действия.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityId?: string;

  @ApiPropertyOptional({
    enum: AuditOutcome,
    description:
      '`SUCCESS` — действие состоялось, `DENIED` — отказ доступа (401/403). ' +
      'Ошибки формы и сервера в журнал не пишутся вовсе.',
  })
  @IsOptional()
  @IsEnum(AuditOutcome)
  outcome?: AuditOutcome;

  @ApiPropertyOptional({ example: '2026-08-01', description: 'Начало периода, включительно.' })
  @IsOptional()
  @Matches(ISO_DATE_PATTERN, { message: 'Ожидается дата в формате YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-08-31',
    description: 'Конец периода, **включительно**: день целиком входит в выборку.',
  })
  @IsOptional()
  @Matches(ISO_DATE_PATTERN, { message: 'Ожидается дата в формате YYYY-MM-DD' })
  to?: string;
}
