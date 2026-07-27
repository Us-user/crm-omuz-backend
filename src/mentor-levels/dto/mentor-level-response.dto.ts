import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus } from '@prisma/client';

/** Ступень справочника уровней ментора (ТЗ 5.14). */
export class MentorLevelDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Senior mentor' })
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiProperty({
    example: 45,
    description:
      'Часовая ставка в сомони. Хранится как DECIMAL(12,2); в JSON отдаётся числом — ' +
      'два знака после запятой в этом диапазоне представимы точно.',
  })
  hourlyRate!: number;

  @ApiProperty({ enum: DirectoryStatus })
  status!: DirectoryStatus;

  @ApiProperty({
    example: 12,
    description:
      'Сколько месяцев эта ступень кому-то проставлена (по всем сотрудникам). ' +
      'На этом счётчике держится запрет удалять уровень, по которому уже считали зарплату.',
  })
  historyCount!: number;

  @ApiProperty({ example: '2026-07-29T10:15:00.000Z' })
  createdAt!: string;
}

/** Ответ на удаление ступени — чтобы интерфейс мог назвать удалённое. */
export class MentorLevelDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Senior mentor' })
  name!: string;
}

/** Ступень внутри строки истории: экран не должен догружать справочник. */
export class MentorLevelBriefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Senior mentor' })
  name!: string;

  @ApiProperty({ example: 45, description: 'Часовая ставка ступени в сомони' })
  hourlyRate!: number;

  @ApiProperty({ enum: DirectoryStatus })
  status!: DirectoryStatus;
}

/** Уровень сотрудника в конкретном месяце (ТЗ 5.14: «история по месяцам»). */
export class MentorLevelHistoryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  employeeId!: string;

  @ApiProperty({
    example: '2026-09',
    description: 'Месяц в формате `YYYY-MM`. Дня в нём нет: в столбце он всегда первый.',
  })
  month!: string;

  @ApiProperty({ type: MentorLevelBriefDto })
  level!: MentorLevelBriefDto;

  @ApiProperty({ example: '2026-07-29T10:15:00.000Z' })
  createdAt!: string;
}

/** Ответ на снятие уровня с месяца. */
export class MentorLevelHistoryRemovedDto {
  @ApiProperty({ format: 'uuid' })
  employeeId!: string;

  @ApiProperty({ example: '2026-09' })
  month!: string;

  @ApiProperty({ example: 'Senior mentor', description: 'Ступень, которая стояла в этом месяце' })
  levelName!: string;
}
