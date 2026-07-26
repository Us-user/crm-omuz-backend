import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EmployeeStatus, GroupMentorRole } from '@prisma/client';

/**
 * Сотрудник в списке менторов группы — ровно то, что рисует карточка
 * (ТЗ 5.5), чтобы экран не догружал профиль по каждой строке.
 */
export class MentorEmployeeDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Фаррух' })
  firstName!: string;

  @ApiProperty({ example: 'Раҳимов' })
  lastName!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Саидович' })
  middleName!: string | null;

  @ApiProperty({ example: '+992901234567', description: 'Контактный телефон в E.164' })
  phone!: string;

  @ApiPropertyOptional({ nullable: true })
  photoUrl!: string | null;

  @ApiProperty({
    enum: EmployeeStatus,
    description:
      'Статус на момент запроса. INACTIVE у уже назначенного ментора возможен: ' +
      'сотрудника вывели из штата, а назначение осталось в истории группы.',
  })
  status!: EmployeeStatus;
}

/** Ментор группы (ТЗ 5.5). */
export class GroupMentorDto {
  @ApiProperty({ format: 'uuid', description: 'Группа, к которой относится назначение' })
  groupId!: string;

  @ApiProperty({ type: MentorEmployeeDto })
  employee!: MentorEmployeeDto;

  @ApiProperty({ enum: GroupMentorRole })
  role!: GroupMentorRole;

  @ApiProperty({ example: '2026-07-27T10:15:00.000Z' })
  assignedAt!: string;
}

/** Ответ на снятие ментора — чтобы интерфейс мог назвать снятого. */
export class GroupMentorRemovedDto {
  @ApiProperty({ format: 'uuid' })
  groupId!: string;

  @ApiProperty({ format: 'uuid' })
  employeeId!: string;

  @ApiProperty({ example: 'Раҳимов Фаррух' })
  fullName!: string;
}
