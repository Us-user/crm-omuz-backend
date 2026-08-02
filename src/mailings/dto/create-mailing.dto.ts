import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MailingAudience, MessageChannel } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

import { trimString } from '../../common';
import { MAX_MESSAGE_BODY, MAX_MESSAGE_TITLE } from './create-template.dto';

/**
 * Составление рассылки (ТЗ 5.19: «Составление (Title/Description/Template) → Send»).
 *
 * `title` и `body` необязательны **только вместе с `templateId`**: шаблон
 * подставляет их снимком, и требовать переписать текст руками значило бы
 * лишить шаблон смысла. Без шаблона оба обязательны — правило проверяет сервис
 * (422), потому что «обязательно, если не передано другое поле» class-validator
 * выражает лишь условными декораторами, читающимися хуже самой проверки.
 */
export class CreateMailingDto {
  @ApiPropertyOptional({
    example: 'Занятия на следующей неделе',
    maxLength: MAX_MESSAGE_TITLE,
    description: '«Title» из ТЗ 5.19. Можно опустить, если передан `templateId`.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MESSAGE_TITLE)
  title?: string;

  @ApiPropertyOptional({
    example: 'Напоминаем: в понедельник занятие переносится на 14:00.',
    maxLength: MAX_MESSAGE_BODY,
    description: '«Description» из ТЗ 5.19 — текст сообщения. Можно опустить при `templateId`.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MESSAGE_BODY)
  body?: string;

  @ApiProperty({
    enum: MessageChannel,
    description: 'Канал доставки (ТЗ 3.4). Он же определяет, какой контакт получателя нужен.',
  })
  @IsEnum(MessageChannel)
  channel!: MessageChannel;

  @ApiProperty({
    enum: MailingAudience,
    description:
      'Аудитория (ТЗ 5.19). Это правило отбора, а не список людей: получатели ' +
      'вычисляются в момент отправки.',
  })
  @IsEnum(MailingAudience)
  audience!: MailingAudience;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Группа-адресат. **Обязательна при `audience = GROUP` и запрещена при остальных** ' +
      '(422): группа у рассылки «всем студентам» означала бы отбор, которого не будет.',
  })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Шаблон, из которого берётся текст (ТЗ 5.19). Текст **копируется снимком**: ' +
      'правка шаблона задним числом не переписывает составленную рассылку. Переданные ' +
      'явно `title`/`body` перекрывают шаблон.',
  })
  @IsOptional()
  @IsUUID()
  templateId?: string;
}
