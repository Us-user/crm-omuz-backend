import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Gender, ParentRelation, StudentStatus } from '@prisma/client';

/** Филиал, в котором учится студент (ТЗ 3.3). */
export class MeBranchDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sadbarg' })
  name!: string;
}

/** Родитель или опекун в собственном профиле студента (ТЗ 4). */
export class MeParentDto {
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

/**
 * Собственный профиль студента (ТЗ 5.3: кабинет — «свой профиль»).
 *
 * Это **не** карточка из админ-стороны: здесь нет заметок администратора
 * (`notes`), нет аккаунта и нет заметок сотрудников о студенте (`Feedback`) —
 * всё это внутренние данные центра о человеке, а не данные человека.
 */
export class MeProfileDto {
  @ApiProperty({ format: 'uuid', description: 'Идентификатор профиля студента' })
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

  @ApiProperty({ type: [String], example: ['+992921112233'], description: 'Доп. телефоны, E.164' })
  extraPhones!: string[];

  @ApiPropertyOptional({ nullable: true, example: '@nigina' })
  telegram!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'https://cdn.omuz.tj/students/nigina.jpg' })
  photoUrl!: string | null;

  @ApiPropertyOptional({ type: MeBranchDto, nullable: true })
  branch!: MeBranchDto | null;

  @ApiProperty({
    enum: StudentStatus,
    description:
      'Статус в центре (ТЗ 5.3). `BLOCK` в кабинете не встречается: заблокированному ' +
      'профилю кабинет закрыт (403).',
  })
  status!: StudentStatus;

  @ApiProperty({ type: [MeParentDto], description: 'Родители и опекуны (ТЗ 4)' })
  parents!: MeParentDto[];

  @ApiProperty({ example: '2026-07-27T10:15:00.000Z', description: 'Когда заведён профиль' })
  createdAt!: string;
}
