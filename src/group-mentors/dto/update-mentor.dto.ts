import { ApiProperty } from '@nestjs/swagger';
import { GroupMentorRole } from '@prisma/client';
import { IsEnum } from 'class-validator';

/**
 * Смена роли уже назначенного ментора (ТЗ 5.5).
 *
 * Роль — единственное, что можно поменять в назначении: сам сотрудник задаётся
 * адресом. Поле обязательное, потому что пустая правка ничего не значит.
 */
export class UpdateGroupMentorDto {
  @ApiProperty({ enum: GroupMentorRole, description: 'Новая роль ментора в группе' })
  @IsEnum(GroupMentorRole)
  role!: GroupMentorRole;
}
