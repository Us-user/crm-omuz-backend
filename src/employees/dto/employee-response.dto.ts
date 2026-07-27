import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus, EmployeeStatus, Gender, GroupMentorRole } from '@prisma/client';

/** Филиал сотрудника — именем, чтобы список не догружал справочник (ТЗ 3.3). */
export class EmployeeBranchDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sadbarg' })
  name!: string;
}

/** Логин сотрудника. Хеш пароля в выборку не входит в принципе. */
export class EmployeeAccountDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '+992901234567', description: 'Логин — телефон в E.164' })
  phone!: string;

  // У аккаунта email обязателен (ТЗ 3.1: по нему идёт сброс пароля), в отличие
  // от контактного email в профиле — тот необязателен и бывает пустым.
  @ApiProperty({ example: 'farrukh@omuz.tj' })
  email!: string;

  @ApiProperty({ enum: AccountStatus })
  status!: AccountStatus;
}

/**
 * Позиция сотрудника (ТЗ 5.14: «Position — мультивыбор»). Она же роль доступа:
 * права сотрудника — объединение прав всех его позиций (ТЗ 3.2, решение Фазы 2).
 */
export class EmployeePositionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Mentor' })
  name!: string;

  @ApiProperty({
    example: false,
    description: 'Системная позиция (`Director`): её нельзя удалить и переименовать.',
  })
  isSystem!: boolean;
}

/** Группа, которую сотрудник ведёт (ТЗ 5.4: раздел «Groups» профиля ментора). */
export class EmployeeGroupDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend-1' })
  name!: string;

  @ApiProperty({ format: 'uuid' })
  courseId!: string;

  @ApiProperty({ example: 'Frontend Basic' })
  courseTitle!: string;

  @ApiProperty({
    enum: GroupMentorRole,
    description: 'Teaching — ведёт занятия, Support — помогает',
  })
  role!: GroupMentorRole;
}

/** Карточка сотрудника (ТЗ 5.14: форма «Employer» и строка списка). */
export class EmployeeDto {
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

  @ApiPropertyOptional({ nullable: true, example: '1994-03-12', description: 'YYYY-MM-DD' })
  birthDate!: string | null;

  @ApiPropertyOptional({ enum: Gender, nullable: true })
  gender!: Gender | null;

  @ApiPropertyOptional({ nullable: true })
  address!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'farrukh@omuz.tj' })
  email!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '@farrukh' })
  telegram!: string | null;

  @ApiPropertyOptional({ nullable: true })
  photoUrl!: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Поле «Experience» формы ТЗ 5.14' })
  experience!: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Поле «Description» формы ТЗ 5.14' })
  description!: string | null;

  @ApiPropertyOptional({ type: EmployeeBranchDto, nullable: true })
  branch!: EmployeeBranchDto | null;

  @ApiProperty({
    enum: EmployeeStatus,
    description: '`INACTIVE` («выведен из штата») означает и закрытый вход: статусы связаны.',
  })
  status!: EmployeeStatus;

  @ApiPropertyOptional({ nullable: true, example: '2026-01-15', description: 'YYYY-MM-DD' })
  hiredAt!: string | null;

  @ApiPropertyOptional({
    type: EmployeeAccountDto,
    nullable: true,
    description: '`null` — сотрудник заведён без логина (ТЗ 5.14: Account опционален).',
  })
  account!: EmployeeAccountDto | null;

  @ApiProperty({
    type: [EmployeePositionDto],
    description: 'Позиции сотрудника — они же его роли доступа (ТЗ 3.2, 5.14).',
  })
  positions!: EmployeePositionDto[];

  @ApiProperty({
    type: [EmployeeGroupDto],
    description: 'Группы, где сотрудник значится ментором (ТЗ 5.4, 5.5).',
  })
  groups!: EmployeeGroupDto[];

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'Профиль студента, из которого вырос этот сотрудник (ТЗ 3.1: выпускник → ментор). ' +
      '`null` — сотрудник заведён напрямую.',
  })
  formerStudentId!: string | null;

  @ApiProperty({ example: '2026-07-27T10:15:00.000Z' })
  createdAt!: string;
}

/** Ответ на удаление — чтобы интерфейс мог назвать удалённого. */
export class EmployeeDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Раҳимов Фаррух' })
  fullName!: string;

  @ApiProperty({
    example: true,
    description: 'Был ли вместе с профилем удалён аккаунт: ТЗ 3.1 не допускает логин без профиля.',
  })
  accountDeleted!: boolean;
}
