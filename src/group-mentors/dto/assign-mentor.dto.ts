import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GroupMentorRole } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

/** Назначение сотрудника ментором группы (ТЗ 5.5). */
export class AssignMentorDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Профиль сотрудника (`Employee.id`), а не аккаунт: ментором может быть сотрудник ' +
      'без логина (ТЗ 5.14 — «Account опционален»).',
  })
  @IsUUID()
  employeeId!: string;

  @ApiPropertyOptional({
    enum: GroupMentorRole,
    default: GroupMentorRole.TEACHING,
    description: 'Teaching — ведёт занятия, Support — помогает на них (ТЗ 5.5)',
  })
  @IsOptional()
  @IsEnum(GroupMentorRole)
  role?: GroupMentorRole;
}
