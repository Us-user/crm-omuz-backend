import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus } from '@prisma/client';

/** Вакансия (ТЗ 5.18). */
export class JobDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend-разработчик' })
  title!: string;

  @ApiProperty({ example: 'ООО «Ромашка»' })
  company!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Работа над кабинетом клиента на React.' })
  description!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'React, TypeScript, опыт от года.' })
  requirements!: string | null;

  @ApiProperty({ example: 'hr@romashka.tj, +992 90 123-45-67 (Фаррух)' })
  contacts!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-11-30',
    description: 'Срок приёма откликов, включительно. `null` — бессрочно.',
  })
  deadline!: string | null;

  @ApiProperty({
    enum: DirectoryStatus,
    description:
      'Active/Inactive. Отличается от срока: место можно закрыть раньше, ' +
      'не переписывая объявленную дату.',
  })
  status!: DirectoryStatus;

  @ApiProperty({
    example: true,
    description:
      'Актуальна ли вакансия **сегодня**: `status = ACTIVE` и срок не прошёл. Отдельной ' +
      'колонкой не хранится — это сравнение дат, и вторая копия того же факта ' +
      'разошлась бы с ними в первый же день.',
  })
  isOpen!: boolean;

  @ApiProperty({ example: '2026-08-04T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-08-04T10:00:00.000Z' })
  updatedAt!: string;
}

/**
 * Вакансия в кабинете студента (`GET /me/jobs`).
 *
 * Своя форма, а не `JobDto`: студенту незачем `status` и `isOpen` — в его список
 * попадают **только** актуальные вакансии, и оба поля были бы константами
 * (`ACTIVE`/`true`), то есть шумом, который читатель принял бы за фильтр.
 */
export class MeJobDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend-разработчик' })
  title!: string;

  @ApiProperty({ example: 'ООО «Ромашка»' })
  company!: string;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiPropertyOptional({ nullable: true })
  requirements!: string | null;

  @ApiProperty({ example: 'hr@romashka.tj, +992 90 123-45-67 (Фаррух)' })
  contacts!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-11-30',
    description: 'До какого дня принимают отклики, включительно. `null` — бессрочно.',
  })
  deadline!: string | null;

  @ApiProperty({ example: '2026-08-04T10:00:00.000Z' })
  createdAt!: string;
}

/** Ответ на удаление вакансии. */
export class JobDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend-разработчик' })
  title!: string;
}
