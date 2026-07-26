import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus, AccountType, EmployeeStatus } from '@prisma/client';

/** Профиль сотрудника, созданный переводом. */
export class PromotedEmployeeDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiPropertyOptional({ nullable: true })
  middleName!: string | null;

  @ApiProperty({ example: '+992901234567', description: 'Рабочий телефон в E.164' })
  phone!: string;

  @ApiPropertyOptional({ nullable: true })
  email!: string | null;

  @ApiProperty({ enum: EmployeeStatus })
  status!: EmployeeStatus;

  @ApiPropertyOptional({ nullable: true, example: '2026-08-01', description: 'Дата приёма' })
  hiredAt!: string | null;

  @ApiProperty({
    format: 'uuid',
    description: 'Профиль студента, из которого вырос сотрудник: учебная история осталась там',
  })
  formerStudentId!: string;
}

/** Аккаунт после перевода: логин прежний, изменился только тип (ТЗ 3.1). */
export class PromotedAccountDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '+992901234567', description: 'Логин — не меняется при переводе' })
  phone!: string;

  @ApiProperty({ example: 'farrukh@example.tj' })
  email!: string;

  @ApiProperty({ enum: AccountType, example: AccountType.EMPLOYEE })
  type!: AccountType;

  @ApiProperty({ enum: AccountStatus })
  status!: AccountStatus;
}

/** Ответ на перевод студента в сотрудники. */
export class PromoteStudentResponseDto {
  @ApiProperty({ type: PromotedEmployeeDto })
  employee!: PromotedEmployeeDto;

  @ApiPropertyOptional({
    type: PromotedAccountDto,
    nullable: true,
    description: 'null, если у студента не было аккаунта (ТЗ 5.3: аккаунт опционален)',
  })
  account!: PromotedAccountDto | null;

  @ApiProperty({
    example: 2,
    description:
      'Сколько сессий погашено. Тип аккаунта зашит в access-токен, поэтому после ' +
      'перевода нужно войти заново — токены со старым типом не должны пережить перевод.',
  })
  revokedSessions!: number;
}
