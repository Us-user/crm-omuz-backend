import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GroupFormat, GroupMentorRole, GroupStatus } from '@prisma/client';

import { MentorBranchDto } from './mentor-profile-response.dto';

/** Курс, по которому учится группа (ТЗ 5.6). */
export class MentorGroupCourseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend' })
  title!: string;

  @ApiPropertyOptional({ nullable: true, example: 'React и TypeScript' })
  subtitle!: string | null;
}

/**
 * Группа под менторством вызывающего (ТЗ 5.4, раздел «Groups»).
 *
 * Состава группы здесь нет: он читается отдельным маршрутом
 * (`GET /groups/{id}/students`) и закрыт правом `Permission.Groups.Views` —
 * кабинет прав не спрашивает и потому персональных данных студентов
 * не отдаёт. Число набранных при этом видно: «набрано/вместимость»
 * (ТЗ 5.5) — характеристика группы, а не сведения о людях.
 */
export class MentorGroupDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend-1' })
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiProperty({ type: MentorGroupCourseDto })
  course!: MentorGroupCourseDto;

  @ApiProperty({ type: MentorBranchDto })
  branch!: MentorBranchDto;

  @ApiProperty({ enum: GroupFormat })
  format!: GroupFormat;

  @ApiProperty({ enum: GroupStatus })
  status!: GroupStatus;

  @ApiPropertyOptional({ nullable: true, example: '2026-09-01', description: 'YYYY-MM-DD' })
  startDate!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-12-01', description: 'YYYY-MM-DD' })
  endDate!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 16,
    description: '«Required students» из ТЗ 5.5 — сколько человек набирают',
  })
  capacity!: number | null;

  @ApiProperty({
    example: 12,
    description: 'Сколько набрано: действующие членства (вторая половина «набрано/вместимость»)',
  })
  enrolledCount!: number;

  @ApiPropertyOptional({ nullable: true, example: 'https://t.me/omuz_front1' })
  telegramUrl!: string | null;

  @ApiProperty({
    enum: GroupMentorRole,
    description: 'Своя роль в этой группе (ТЗ 5.5: Teaching/Support)',
  })
  role!: GroupMentorRole;

  @ApiProperty({ example: '2026-08-20T09:00:00.000Z', description: 'Когда назначен ментором' })
  assignedAt!: string;
}
