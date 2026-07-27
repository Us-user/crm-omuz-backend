import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus, Gender, ParentRelation, StudentStatus } from '@prisma/client';

/** Филиал студента в карточке (ТЗ 3.3) — без второго запроса за названием. */
export class StudentBranchDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sadbarg' })
  name!: string;
}

/**
 * Аккаунт студента, если он выдан (ТЗ 5.3: «аккаунт опционален, Invite»).
 * Хеша пароля здесь нет и быть не может — наружу уходит только то,
 * что показывает карточка: логин, почта и не заблокирован ли вход.
 */
export class StudentAccountDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '+992901234567', description: 'Логин — телефон в E.164' })
  phone!: string;

  @ApiProperty({ example: 'nigina@mail.tj' })
  email!: string;

  @ApiProperty({ enum: AccountStatus })
  status!: AccountStatus;
}

/**
 * Родитель или опекун в карточке студента (ТЗ 4). Здесь — только контакт;
 * ведение списка (добавление, правка, отвязка) живёт в `/students/{id}/parents`.
 */
export class StudentParentContactDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Гулнора' })
  firstName!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Каримова' })
  lastName!: string | null;

  @ApiProperty({ example: '+992907654321' })
  phone!: string;

  @ApiPropertyOptional({ enum: ParentRelation, nullable: true })
  relation!: ParentRelation | null;
}

/** Действующее членство студента — «Group» и «Course» из фильтров ТЗ 5.3. */
export class StudentGroupDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend-1' })
  name!: string;

  @ApiProperty({ format: 'uuid' })
  courseId!: string;

  @ApiProperty({ example: 'Frontend Basic' })
  courseTitle!: string;
}

/** Карточка студента (ТЗ 5.3: форма и список). */
export class StudentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Нигина' })
  firstName!: string;

  @ApiProperty({ example: 'Каримова' })
  lastName!: string;

  @ApiProperty({ example: '+992901234567', description: 'Контактный телефон, E.164' })
  phone!: string;

  @ApiPropertyOptional({ nullable: true, example: '2004-05-17', description: 'YYYY-MM-DD' })
  birthDate!: string | null;

  @ApiPropertyOptional({ enum: Gender, nullable: true })
  gender!: Gender | null;

  @ApiPropertyOptional({ nullable: true })
  address!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'nigina@mail.tj' })
  email!: string | null;

  @ApiProperty({
    type: [StudentParentContactDto],
    description:
      'Родители и опекуны (ТЗ 4). Прежняя колонка `parentPhone` убрана: контакт ' +
      'родителя живёт в общей записи, найти которую можно по телефону.',
  })
  parents!: StudentParentContactDto[];

  @ApiProperty({ type: [String], example: ['+992921112233'], description: 'Доп. телефоны, E.164' })
  extraPhones!: string[];

  @ApiPropertyOptional({ nullable: true, example: '@nigina' })
  telegram!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'https://cdn.omuz.tj/students/nigina.jpg' })
  photoUrl!: string | null;

  @ApiPropertyOptional({ nullable: true })
  notes!: string | null;

  @ApiPropertyOptional({ type: StudentBranchDto, nullable: true })
  branch!: StudentBranchDto | null;

  @ApiProperty({ enum: StudentStatus })
  status!: StudentStatus;

  @ApiPropertyOptional({
    type: StudentAccountDto,
    nullable: true,
    description: '`null` — студент заведён без логина и ждёт приглашения (ТЗ 5.3).',
  })
  account!: StudentAccountDto | null;

  @ApiProperty({
    type: [StudentGroupDto],
    description: 'Группы, в которых студент учится сейчас. Закрытые членства сюда не попадают.',
  })
  activeGroups!: StudentGroupDto[];

  @ApiProperty({
    example: 3,
    description: 'Сколько всего членств у студента, включая закрытые, — это его учебная история.',
  })
  groupsCount!: number;

  @ApiProperty({ example: '2026-07-27T10:15:00.000Z' })
  createdAt!: string;
}

/** Ответ на удаление — чтобы интерфейс мог назвать удалённого. */
export class StudentDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Каримова Нигина' })
  fullName!: string;

  @ApiProperty({
    example: true,
    description: 'Был ли вместе с профилем удалён аккаунт: ТЗ 3.1 не допускает логин без профиля.',
  })
  accountDeleted!: boolean;
}
