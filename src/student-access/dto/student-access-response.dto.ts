import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus, StudentStatus } from '@prisma/client';

/** Аккаунт студента после действия над доступом — без хеша пароля, как в карточке. */
export class StudentAccessAccountDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '+992901234567', description: 'Логин — контактный телефон в E.164' })
  phone!: string;

  @ApiProperty({ example: 'nigina@mail.tj' })
  email!: string;

  @ApiProperty({ enum: AccountStatus })
  status!: AccountStatus;
}

/** Результат блокировки или разблокировки (ТЗ 5.3). */
export class StudentBlockedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Каримова Нигина' })
  fullName!: string;

  @ApiProperty({ example: true, description: 'Итоговое состояние: закрыт ли вход студенту.' })
  blocked!: boolean;

  @ApiProperty({ enum: StudentStatus, description: 'Статус профиля после действия.' })
  status!: StudentStatus;

  @ApiPropertyOptional({
    type: StudentAccessAccountDto,
    nullable: true,
    description: '`null` — у студента нет логина: блокировать нечего, заблокирован только профиль.',
  })
  account!: StudentAccessAccountDto | null;

  @ApiProperty({
    example: 2,
    description:
      'Сколько сессий погашено. Обновить токены заблокированный уже не сможет, ' +
      'но выданный ранее access-токен доживёт свой час (решение сессии 0002).',
  })
  revokedSessions!: number;
}

/** Результат приглашения (ТЗ 5.3: Invite). */
export class StudentInvitedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Каримова Нигина' })
  fullName!: string;

  @ApiProperty({ type: StudentAccessAccountDto })
  account!: StudentAccessAccountDto;

  @ApiProperty({
    example: 'nigina@mail.tj',
    description:
      'Куда ушло письмо с одноразовым кодом. Пароль задаёт сам студент через ' +
      '`POST /auth/password/reset` — системе он неизвестен.',
  })
  codeSentTo!: string;
}
