import { ApiProperty } from '@nestjs/swagger';
import { MessageChannel } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

import { trimString } from '../../common';
import { MAX_MESSAGE_BODY, MAX_MESSAGE_TITLE } from './create-template.dto';

/**
 * Рассылка ментора своей группе (ТЗ 5.4: пункт меню «SMS mailings» ведёт
 * в модуль рассылок — 0023).
 *
 * Аудитория и группа не спрашиваются: аудитория всегда «своя группа», а группа —
 * `groupId`, и то, что она **своя**, проверяет сервис менторством, а не право
 * «писать любой группе». Шаблона тоже нет: ментор пишет текст руками — раздел
 * узкий, и подстановка шаблонов сюда не переносится.
 */
export class SendGroupMailingDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Группа-адресат. Должна быть одной из групп, которые ведёт вызывающий (иначе 422).',
  })
  @IsUUID()
  groupId!: string;

  @ApiProperty({
    enum: MessageChannel,
    description: 'Канал доставки (ТЗ 3.4). Он же определяет, какой контакт студента нужен.',
  })
  @IsEnum(MessageChannel)
  channel!: MessageChannel;

  @ApiProperty({
    example: 'Завтра занятие переносится на 14:00.',
    maxLength: MAX_MESSAGE_TITLE,
    description: 'Заголовок сообщения.',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MESSAGE_TITLE)
  title!: string;

  @ApiProperty({
    example: 'Здравствуйте! Напоминаем: занятие в понедельник переносится на 14:00.',
    maxLength: MAX_MESSAGE_BODY,
    description: 'Текст сообщения. Поддерживает подстановку {{firstName}} и {{lastName}}.',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MESSAGE_BODY)
  body!: string;
}
