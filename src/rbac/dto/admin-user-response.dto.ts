import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus, AccountType, Locale } from '@prisma/client';

/** Роль аккаунта = позиция его сотрудника (ТЗ 3.2, 5.15). */
export class UserRoleDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Manager' })
  name!: string;

  @ApiProperty({ example: false })
  isSystem!: boolean;
}

/** Аккаунт в списке `Administration → Users` (ТЗ 5.15). */
export class AdminUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '+992901234567', description: 'Логин — телефон в E.164' })
  phone!: string;

  @ApiProperty({ example: 'farrukh@example.tj' })
  email!: string;

  @ApiProperty({ enum: AccountType })
  type!: AccountType;

  @ApiProperty({ enum: AccountStatus })
  status!: AccountStatus;

  @ApiProperty({ enum: Locale })
  locale!: Locale;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Раҳимов Фаррух',
    description: 'Имя из профиля; null, если профиль ещё не привязан',
  })
  fullName!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    format: 'uuid',
    description: 'Идентификатор профиля (студента или сотрудника)',
  })
  profileId!: string | null;

  @ApiProperty({
    type: [UserRoleDto],
    description: 'Позиции сотрудника. У студента список всегда пуст: права даёт только позиция.',
  })
  roles!: UserRoleDto[];

  @ApiPropertyOptional({ nullable: true, example: '2026-07-26T10:15:00.000Z' })
  lastLoginAt!: string | null;

  @ApiProperty({ example: '2026-07-01T08:00:00.000Z' })
  createdAt!: string;
}

/** Результат назначения или снятия ролей. */
export class UserRolesDto {
  @ApiProperty({ format: 'uuid' })
  accountId!: string;

  @ApiProperty({ format: 'uuid', description: 'Профиль сотрудника, которому принадлежат роли' })
  employeeId!: string;

  @ApiProperty({ type: [UserRoleDto], description: 'Роли после изменения' })
  roles!: UserRoleDto[];

  @ApiProperty({
    example: 1,
    description:
      'Сколько назначений реально изменилось. 0 означает, что запрос ничего не поменял ' +
      '(роль уже была назначена или уже была снята).',
  })
  changed!: number;
}
