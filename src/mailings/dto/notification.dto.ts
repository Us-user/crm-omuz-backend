import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MessageChannel, NotificationRecipientType, NotificationStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto } from '../../common';

/** Список доставок рассылки — «дошло ли до конкретного человека». */
export class NotificationQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: NotificationStatus,
    description: 'Отбор по состоянию доставки: `FAILED` — кому не дошло.',
  })
  @IsOptional()
  @IsEnum(NotificationStatus)
  status?: NotificationStatus;
}

/** Доставка одному получателю (ТЗ 4: `Notification`). */
export class NotificationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: MessageChannel })
  channel!: MessageChannel;

  @ApiProperty({ enum: NotificationRecipientType })
  recipientType!: NotificationRecipientType;

  @ApiProperty({
    example: 'Умед Раҳимов',
    description: 'Имя на момент отправки — снимок: профиль потом могли переименовать.',
  })
  recipientName!: string;

  @ApiProperty({
    example: '@umed',
    description: 'Адрес на момент отправки. Что именно в нём лежит, говорит `channel`.',
  })
  address!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Профиль получателя. `null`, если профиль позже удалили — имя и адрес остаются.',
  })
  recipientId!: string | null;

  @ApiProperty({ enum: NotificationStatus })
  status!: NotificationStatus;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Адрес канала у получателя не указан',
    description: 'Причина отказа или пометка «адреса нет». Хранится последняя.',
  })
  error!: string | null;

  @ApiProperty({ example: 1, description: 'Сколько раз обработчик брался за эту доставку.' })
  attempts!: number;

  @ApiPropertyOptional({ nullable: true, example: '2026-08-15T10:00:05.000Z' })
  sentAt!: string | null;

  @ApiProperty({ example: '2026-08-15T10:00:00.000Z' })
  createdAt!: string;
}
