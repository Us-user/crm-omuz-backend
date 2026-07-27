import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GraduateEmployment, StudentStatus } from '@prisma/client';

import { ActivityCategory } from '../../performance/performance';

/** Кто выпустился. */
export class GraduateStudentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Нигина' })
  firstName!: string;

  @ApiProperty({ example: 'Каримова' })
  lastName!: string;

  @ApiProperty({ example: '+992901234567' })
  phone!: string;

  @ApiPropertyOptional({ nullable: true, example: 'https://cdn.omuz.tj/students/1.jpg' })
  photoUrl!: string | null;

  @ApiProperty({
    enum: StudentStatus,
    description:
      'Статус профиля (ТЗ 5.3). Выводится из **всех** членств человека, поэтому ' +
      'у выпустившегося с одного курса и продолжающего на другом здесь будет `ACTIVE`.',
  })
  status!: StudentStatus;
}

/** Именованная ссылка: группа, курс или филиал. */
export class GraduateRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend-1' })
  name!: string;
}

/** Кто выдал сертификат. */
export class GraduateIssuerDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Фаррух' })
  firstName!: string;

  @ApiProperty({ example: 'Раҳимов' })
  lastName!: string;
}

/** Сертификат выпускника (ТЗ 5.11, 3.7). */
export class GraduateCertificateDto {
  @ApiProperty({
    example: true,
    description:
      'Выдан ли сертификат. Отдельной колонкой флаг не хранится — выдан тот, ' +
      'у кого есть серийный номер.',
  })
  issued!: boolean;

  @ApiPropertyOptional({ nullable: true, example: 'OMZ-2026-000148' })
  serial!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-07-05' })
  issuedAt!: string | null;

  @ApiPropertyOptional({
    type: GraduateIssuerDto,
    nullable: true,
    description: 'Сотрудник, выдавший сертификат. `null` — его профиль удалён.',
  })
  issuedBy!: GraduateIssuerDto | null;
}

/** Строка витрины выпускников (ТЗ 5.11). */
export class GraduateDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: GraduateStudentDto })
  student!: GraduateStudentDto;

  @ApiProperty({ type: GraduateRefDto, description: 'Группа, из которой выпустился.' })
  group!: GraduateRefDto;

  @ApiProperty({ type: GraduateRefDto, description: 'Курс выпускающей группы.' })
  course!: GraduateRefDto;

  @ApiProperty({ type: GraduateRefDto, description: 'Филиал выпускающей группы (ТЗ 3.3).' })
  branch!: GraduateRefDto;

  @ApiProperty({ example: '2026-06-30', description: 'Дата выпуска.' })
  graduatedAt!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 87.33,
    description:
      '«Points» из ТЗ 5.11 — общий балл на момент выпуска (ТЗ 5.8). Это **снимок**: ' +
      'последующие правки журнала его не меняют. `null` — у выпускника не было ни одной ' +
      'финализированной недели, и это не ноль (правило сессии 0019).',
  })
  points!: number | null;

  @ApiProperty({ example: 12, description: 'Сколько закрытых недель учтено в балле.' })
  weeksCount!: number;

  @ApiPropertyOptional({
    enum: ActivityCategory,
    nullable: true,
    description:
      '«Level» из ТЗ 5.11 — категория активности (ТЗ 5.5), выведенная из `points`. ' +
      'Отдельной колонкой не хранится: снимком её делает замороженный балл, а вторая ' +
      'копия порогов разошлась бы с первой. `null` — балла нет, уровня тоже.',
  })
  level!: ActivityCategory | null;

  @ApiPropertyOptional({ nullable: true, example: 'Handsome' })
  levelTitle!: string | null;

  @ApiPropertyOptional({
    enum: GraduateEmployment,
    nullable: true,
    description: 'Статус трудоустройства (ТЗ 5.11). `null` — не выяснен.',
  })
  employment!: GraduateEmployment | null;

  @ApiPropertyOptional({ nullable: true, example: 'ООО «Алиф Технолоджи»' })
  workPlace!: string | null;

  @ApiProperty({ type: GraduateCertificateDto })
  certificate!: GraduateCertificateDto;

  @ApiProperty({
    example: '2026-06-30T09:12:00.000Z',
    description: 'Когда заведена запись выпуска.',
  })
  createdAt!: string;
}

/**
 * Счётчики трудоустройства (ТЗ 5.11). Уходят в `meta` списка: они одни на все
 * страницы — тот же случай, что баланс коинов (0018) и топ-3 рейтинга (0024).
 */
export class GraduateEmploymentCountsDto {
  @ApiProperty({ example: 4 })
  openToWork!: number;

  @ApiProperty({ example: 11 })
  work!: number;

  @ApiProperty({ example: 2 })
  freelancer!: number;

  @ApiProperty({ example: 1 })
  furtherEducation!: number;

  @ApiProperty({ example: 0 })
  entrepreneur!: number;

  @ApiProperty({
    example: 7,
    description: 'У скольких статус ещё не выяснен. Отдельно от «ищет работу».',
  })
  unknown!: number;
}

/** Итог автовыпуска — возвращается вызывающему `PUT /groups/{id}` не напрямую, а логом. */
export class GraduationResultDto {
  @ApiProperty({ format: 'uuid' })
  groupId!: string;

  @ApiProperty({ example: 14, description: 'Сколько выпускников заведено этим вызовом.' })
  graduated!: number;

  @ApiProperty({ type: [GraduateDto] })
  graduates!: GraduateDto[];
}
