import { ApiPropertyOptional } from '@nestjs/swagger';
import { MailingAudience, MessageChannel } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/** Поля, по которым разрешено сортировать список рассылок. */
export enum MailingSortField {
  CreatedAt = 'createdAt',
  SentAt = 'sentAt',
  Title = 'title',
}

/** Тот же разбор, что у `hasAccount` в списке студентов (0014). */
const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/**
 * Список рассылок (ТЗ 5.19).
 *
 * Фильтра по **состоянию** рассылки здесь нет, и это не забывчивость:
 * состояние выводится из счётчиков доставок (`mailingStatusOf`), то есть
 * фильтр по нему потребовал бы подзапроса на каждую строку. Вместо него
 * стоит `sent` — разделение на черновики и отправленные, которое читается
 * прямо из колонки `sentAt` и отвечает на тот же вопрос экрана.
 */
export class MailingQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: MailingSortField, default: MailingSortField.CreatedAt })
  @IsOptional()
  @IsEnum(MailingSortField)
  override sort: MailingSortField = MailingSortField.CreatedAt;

  // Рассылки читают свежими сверху — как лидов (0027) и платежи (0029).
  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Desc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({ enum: MailingAudience })
  @IsOptional()
  @IsEnum(MailingAudience)
  audience?: MailingAudience;

  @ApiPropertyOptional({ enum: MessageChannel })
  @IsOptional()
  @IsEnum(MessageChannel)
  channel?: MessageChannel;

  @ApiPropertyOptional({ format: 'uuid', description: 'Рассылки, адресованные этой группе.' })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({
    description: '`true` — только отправленные, `false` — только черновики.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  sent?: boolean;
}
