import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus, MessageChannel } from '@prisma/client';

/** Сотрудник, названный в карточке (автор шаблона, отправитель рассылки). */
export class MailingActorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Нигина' })
  firstName!: string;

  @ApiProperty({ example: 'Каримова' })
  lastName!: string;
}

/** Шаблон сообщения (ТЗ 5.19). */
export class TemplateDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Напоминание об оплате' })
  name!: string;

  @ApiProperty({ example: 'Оплата обучения', description: '«Title» из ТЗ 5.19.' })
  title!: string;

  @ApiProperty({
    example: 'Напоминаем, что оплату за месяц нужно внести до 5 числа.',
    description: '«Description» из ТЗ 5.19 — текст сообщения.',
  })
  body!: string;

  @ApiPropertyOptional({
    enum: MessageChannel,
    nullable: true,
    description: '`null` — шаблон годится любому каналу.',
  })
  channel!: MessageChannel | null;

  @ApiProperty({ enum: DirectoryStatus })
  status!: DirectoryStatus;

  @ApiProperty({
    example: 4,
    description:
      'Сколько рассылок составлено по этому шаблону. Удалению не мешает: текст ' +
      'рассылки — снимок, и она не теряет ничего, кроме указателя на источник.',
  })
  mailingsCount!: number;

  @ApiPropertyOptional({ type: MailingActorDto, nullable: true })
  createdBy!: MailingActorDto | null;

  @ApiProperty({ example: '2026-08-15T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-08-15T10:00:00.000Z' })
  updatedAt!: string;
}

/** Ответ на удаление шаблона. */
export class TemplateDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Напоминание об оплате' })
  name!: string;
}
