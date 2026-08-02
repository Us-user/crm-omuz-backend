import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus, MessageChannel } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { trimString } from '../../common';

/**
 * Потолок длины сообщения. Одна SMS — 70 символов кириллицей, и провайдеры
 * склеивают длинный текст в несколько частей; 2000 символов это уже около
 * тридцати SMS. Потолок не про технику, а про цену: без него опечатка в поле
 * ввода превращается в счёт от агрегатора.
 */
export const MAX_MESSAGE_BODY = 2000;

/** Заголовок сообщения — строка списка, а не текст. */
export const MAX_MESSAGE_TITLE = 200;

/**
 * Пустая строка в необязательном перечислении означает «снять значение».
 * Отдельный трансформер, а не `trimString`: `@IsOptional()` пропускает `null`
 * и `undefined`, но пустую строку проверил бы `@IsEnum` — и очистка поля
 * возвращала бы 400 вместо того, чтобы очищать (то же разведение намерений,
 * что у `emptyToNull` для текстовых полей).
 */
export const emptyToNullValue = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();

  return trimmed === '' ? null : trimmed;
};

/** Создание шаблона (ТЗ 5.19: «Шаблоны (CRUD)»). */
export class CreateTemplateDto {
  @ApiProperty({
    example: 'Напоминание об оплате',
    minLength: 2,
    maxLength: 100,
    description: 'Как шаблон называют в списке выбора. Уникально без учёта регистра.',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    example: 'Оплата обучения',
    maxLength: MAX_MESSAGE_TITLE,
    description: '«Title» из ТЗ 5.19 — заголовок сообщения.',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MESSAGE_TITLE)
  title!: string;

  @ApiProperty({
    example: 'Напоминаем, что оплату за месяц нужно внести до 5 числа.',
    maxLength: MAX_MESSAGE_BODY,
    description: '«Description» из ТЗ 5.19 — текст сообщения.',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MESSAGE_BODY)
  body!: string;

  @ApiPropertyOptional({
    enum: MessageChannel,
    nullable: true,
    description:
      'Канал, под который написан текст. **Необязателен**: текст, годный и для ' +
      'Telegram, и для SMS, не нужно копировать дважды. Пустая строка снимает привязку — ' +
      '`@IsOptional()` пропускает `null`, поэтому очистка проходит проверку, а мусор нет.',
  })
  @IsOptional()
  @Transform(emptyToNullValue)
  @IsEnum(MessageChannel)
  channel?: MessageChannel | null;

  @ApiPropertyOptional({ enum: DirectoryStatus, default: DirectoryStatus.ACTIVE })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;
}
