import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GroupFormat, GroupMentorRole, GroupStatus, GroupStudentStatus } from '@prisma/client';

import { MeBranchDto } from './me-profile-response.dto';

/** Курс группы (ТЗ 5.6) — ровно то, чем группа подписана в кабинете. */
export class MeCourseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend Basic' })
  title!: string;

  @ApiPropertyOptional({ nullable: true, example: 'HTML, CSS, JavaScript' })
  subtitle!: string | null;
}

/**
 * Ментор группы (ТЗ 5.5: роли Teaching/Support).
 *
 * Только имя и роль: телефон и почта ментора — контакты сотрудника, и кабинету
 * студента они не нужны.
 */
export class MeMentorDto {
  @ApiProperty({ format: 'uuid', description: 'Профиль сотрудника (`Employee.id`)' })
  id!: string;

  @ApiProperty({ example: 'Фаррух' })
  firstName!: string;

  @ApiProperty({ example: 'Раҳимов' })
  lastName!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Саидович' })
  middleName!: string | null;

  @ApiProperty({ enum: GroupMentorRole, description: 'Ведёт занятия или помогает' })
  role!: GroupMentorRole;
}

/**
 * Группа студента (ТЗ 5.3: кабинет — «свои группы»).
 *
 * Одна строка = одно членство, включая закрытые: они и есть учебная история
 * человека (решение сессии 0012 — вторую таблицу «история зачислений»
 * не заводили). Отобрать только действующие можно фильтром `status`.
 */
export class MeGroupDto {
  @ApiProperty({ format: 'uuid', description: 'Идентификатор группы' })
  id!: string;

  @ApiProperty({ example: 'Frontend-1' })
  name!: string;

  @ApiProperty({ type: MeCourseDto })
  course!: MeCourseDto;

  @ApiPropertyOptional({ type: MeBranchDto, nullable: true })
  branch!: MeBranchDto | null;

  @ApiProperty({ enum: GroupFormat, description: 'Online или Offline (ТЗ 5.5)' })
  format!: GroupFormat;

  @ApiProperty({ enum: GroupStatus, description: 'Состояние самой группы (ТЗ 5.5)' })
  groupStatus!: GroupStatus;

  @ApiPropertyOptional({ nullable: true, example: '2026-09-01', description: 'YYYY-MM-DD' })
  startDate!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-11-30', description: 'YYYY-MM-DD' })
  endDate!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'https://t.me/omuz_frontend_1' })
  telegramUrl!: string | null;

  @ApiProperty({ type: [MeMentorDto], description: 'Кто ведёт группу (ТЗ 5.5)' })
  mentors!: MeMentorDto[];

  @ApiProperty({
    enum: GroupStudentStatus,
    description: 'Статус участия в этой группе: `ACTIVE` — учится сейчас, остальные — история',
  })
  status!: GroupStudentStatus;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Перевёлся в вечернюю группу',
    description: 'Причина последней смены статуса (ТЗ 5.5: Reason)',
  })
  statusReason!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-10-15T08:30:00.000Z' })
  statusChangedAt!: string | null;

  @ApiProperty({ example: '2026-09-01T10:15:00.000Z', description: 'Когда зачислен в группу' })
  enrolledAt!: string;
}
