import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { trimString } from '../../common';

/**
 * Потолки длин. Описание и требования — это абзацы объявления, а не резюме
 * компании, поэтому потолок у них тот же, что у описания купона (0027),
 * увеличенный вчетверо: вакансию читают целиком, и обрезать её на середине
 * фразы значило бы отдать нечитаемый текст.
 */
export const MAX_JOB_TEXT = 4000;

/** Дата срока либо пустая строка, снимающая его (приём сроков группы, 0008). */
const OPTIONAL_ISO_DATE = /^$|^\d{4}-\d{2}-\d{2}$/;

/**
 * Создание вакансии (ТЗ 5.18: «поля уточняются — название, описание, компания,
 * требования, контакты, срок»).
 *
 * Обязательны три: название, компания и контакты. Первые два отвечают на вопрос
 * «что и куда», третий — «как откликнуться»; вакансия без любого из них
 * не является объявлением. Описание, требования и срок необязательны: их
 * дописывают по мере того, как работодатель их сообщает.
 */
export class CreateJobDto {
  @ApiProperty({ example: 'Frontend-разработчик', minLength: 2, maxLength: 200 })
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @ApiProperty({
    example: 'ООО «Ромашка»',
    minLength: 2,
    maxLength: 200,
    description: 'Работодатель. Уникальным не является: одна компания открывает вакансии не раз.',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  company!: string;

  @ApiPropertyOptional({ maxLength: MAX_JOB_TEXT, description: 'Пустая строка очищает поле.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(MAX_JOB_TEXT)
  description?: string;

  @ApiPropertyOptional({ maxLength: MAX_JOB_TEXT, description: 'Пустая строка очищает поле.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(MAX_JOB_TEXT)
  requirements?: string;

  @ApiProperty({
    example: 'hr@romashka.tj, +992 90 123-45-67 (Фаррух)',
    minLength: 2,
    maxLength: 500,
    description:
      'Как откликнуться — свободный текст. Одним полем, а не разбором на телефон ' +
      'и почту: рассылок по этим адресам центр не ведёт, а три необязательные ' +
      'колонки разрешили бы вакансию вообще без способа связи.',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  contacts!: string;

  @ApiPropertyOptional({
    example: '2026-11-30',
    description:
      'Срок приёма откликов `YYYY-MM-DD`, **включительно**. Пустая строка снимает срок: ' +
      'бессрочный набор — законное состояние.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(OPTIONAL_ISO_DATE, { message: 'deadline должна быть датой в формате YYYY-MM-DD' })
  deadline?: string;

  @ApiPropertyOptional({
    enum: DirectoryStatus,
    default: DirectoryStatus.ACTIVE,
    description:
      'Active/Inactive. Стоит рядом со сроком, а не вместо него: место закрывают ' +
      'раньше объявленного срока чаще, чем доводят до него.',
  })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;
}
