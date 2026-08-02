import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MailingAudience, MessageChannel } from '@prisma/client';

import { MailingStatus } from '../mailings';
import { MailingActorDto } from './template-response.dto';

/** Группа-адресат рассылки. */
export class MailingGroupDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend-1' })
  name!: string;
}

/** Шаблон, из которого взят текст (только происхождение). */
export class MailingTemplateRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Напоминание об оплате' })
  name!: string;
}

/** Счётчики доставок рассылки (ТЗ 5.19: история). */
export class DeliveryCountsDto {
  @ApiProperty({ example: 24, description: 'Сколько получателей отобрала аудитория.' })
  total!: number;

  @ApiProperty({ example: 2, description: 'Ещё в очереди.' })
  pending!: number;

  @ApiProperty({ example: 20, description: 'Принято провайдером.' })
  sent!: number;

  @ApiProperty({ example: 1, description: 'Провайдер отказал — причина в строке доставки.' })
  failed!: number;

  @ApiProperty({
    example: 1,
    description:
      'Адреса этого канала у получателя нет. Отдельно от `failed`: это не сбой ' +
      'доставки, а пробел в данных, и повтор упавших такие строки не трогает.',
  })
  skipped!: number;
}

/** Рассылка (ТЗ 5.19). */
export class MailingDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Занятия на следующей неделе' })
  title!: string;

  @ApiProperty({ example: 'Напоминаем: в понедельник занятие переносится на 14:00.' })
  body!: string;

  @ApiProperty({ enum: MessageChannel })
  channel!: MessageChannel;

  @ApiProperty({ enum: MailingAudience })
  audience!: MailingAudience;

  @ApiPropertyOptional({ type: MailingGroupDto, nullable: true })
  group!: MailingGroupDto | null;

  @ApiPropertyOptional({
    type: MailingTemplateRefDto,
    nullable: true,
    description:
      'Откуда взят текст. Только происхождение: сам текст скопирован в рассылку ' +
      'снимком, и удаление шаблона его не трогает.',
  })
  template!: MailingTemplateRefDto | null;

  @ApiProperty({
    enum: MailingStatus,
    description:
      'Состояние рассылки. **Не хранится в БД**, а выводится из даты отправки ' +
      'и счётчиков доставок: `DRAFT` — не отправлена, `SENDING` — часть доставок ' +
      'ещё в очереди, `SENT` — дошло до всех, `PARTIAL` — часть не дошла, ' +
      '`FAILED` — не дошло ни до кого.',
  })
  status!: MailingStatus;

  @ApiProperty({ type: DeliveryCountsDto })
  deliveries!: DeliveryCountsDto;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-08-15T10:00:00.000Z',
    description: '`null` — черновик. Отдельного флага «отправлена» нет.',
  })
  sentAt!: string | null;

  @ApiPropertyOptional({ type: MailingActorDto, nullable: true })
  sentBy!: MailingActorDto | null;

  @ApiPropertyOptional({ type: MailingActorDto, nullable: true })
  createdBy!: MailingActorDto | null;

  @ApiProperty({ example: '2026-08-15T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-08-15T10:00:00.000Z' })
  updatedAt!: string;
}

/** Ответ на удаление рассылки. */
export class MailingDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Занятия на следующей неделе' })
  title!: string;
}
