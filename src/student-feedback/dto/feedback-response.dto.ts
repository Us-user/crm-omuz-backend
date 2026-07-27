import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Автор заметки — сотрудник, который её оставил (ТЗ 5.3). */
export class FeedbackAuthorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Фаррух' })
  firstName!: string;

  @ApiProperty({ example: 'Раҳимов' })
  lastName!: string;
}

/** Заметка сотрудника о студенте. */
export class FeedbackDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Пропустил две недели по болезни, догнал программу самостоятельно.' })
  text!: string;

  @ApiPropertyOptional({
    type: FeedbackAuthorDto,
    nullable: true,
    description:
      '`null` — автор больше не работает в центре: профиль сотрудника удалён, ' +
      'а заметка осталась, потому что она про студента.',
  })
  author!: FeedbackAuthorDto | null;

  @ApiProperty({ example: '2026-07-28T09:30:00.000Z' })
  createdAt!: string;
}

/** Ответ на удаление заметки — чтобы интерфейс мог сказать, что именно убрал. */
export class FeedbackDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    example: 'Пропустил две недели по болезни…',
    description: 'Начало удалённой заметки.',
  })
  text!: string;
}
