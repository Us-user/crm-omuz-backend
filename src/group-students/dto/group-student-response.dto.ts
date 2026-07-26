import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GroupStudentStatus, StudentStatus } from '@prisma/client';

/**
 * Студент в составе группы — ровно то, что рисует карточка (ТЗ 5.5),
 * чтобы экран не догружал профиль по каждой строке.
 */
export class GroupStudentProfileDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Нигина' })
  firstName!: string;

  @ApiProperty({ example: 'Каримова' })
  lastName!: string;

  @ApiProperty({ example: '+992901234567', description: 'Контактный телефон в E.164' })
  phone!: string;

  @ApiPropertyOptional({ nullable: true })
  photoUrl!: string | null;

  @ApiProperty({
    enum: StudentStatus,
    description:
      'Статус самого студента в центре (ТЗ 5.3) — не путать со `status` членства. ' +
      'Им управляет карточка студента, а не состав группы.',
  })
  status!: StudentStatus;
}

/** Членство студента в группе (ТЗ 5.5). */
export class GroupStudentDto {
  @ApiProperty({ format: 'uuid', description: 'Группа, к которой относится членство' })
  groupId!: string;

  @ApiProperty({ type: GroupStudentProfileDto })
  student!: GroupStudentProfileDto;

  @ApiProperty({
    enum: GroupStudentStatus,
    description: 'Статус участия именно в этой группе (ТЗ 5.5)',
  })
  status!: GroupStudentStatus;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Переехал в другой город',
    description: 'Reason последней смены статуса (ТЗ 5.5, 5.12). У зачисленного — null.',
  })
  statusReason!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-09-15T08:30:00.000Z',
    description: 'Когда статус меняли (ТЗ 5.12: «причина и дата»)',
  })
  statusChangedAt!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Группа, из которой студент переведён сюда (ТЗ 5.5: Transfer)',
  })
  transferredFrom!: { id: string; name: string } | null;

  @ApiProperty({ example: '2026-09-01T10:15:00.000Z' })
  enrolledAt!: string;
}

/**
 * Ответ на зачисление. Кроме самих членств отдаётся «набрано» — то самое
 * «Required students = набрано/вместимость» из ТЗ 5.5, ради которого экран
 * иначе перезапрашивал бы карточку группы сразу после зачисления.
 */
export class GroupStudentsAddedDto {
  @ApiProperty({ format: 'uuid' })
  groupId!: string;

  @ApiProperty({ type: [GroupStudentDto] })
  students!: GroupStudentDto[];

  @ApiProperty({ example: 12, description: 'Сколько студентов учится в группе после зачисления' })
  enrolledCount!: number;
}

/** Ответ на массовую смену статуса (ТЗ 5.5). */
export class GroupStudentsStatusChangedDto {
  @ApiProperty({ format: 'uuid' })
  groupId!: string;

  @ApiProperty({ enum: GroupStudentStatus })
  status!: GroupStudentStatus;

  @ApiProperty({ type: [GroupStudentDto] })
  students!: GroupStudentDto[];

  @ApiProperty({ example: 10, description: 'Сколько студентов учится в группе после смены' })
  enrolledCount!: number;
}

/** Ответ на массовый перевод (ТЗ 5.5). */
export class GroupStudentsTransferredDto {
  @ApiProperty({ format: 'uuid', description: 'Группа, из которой переводили' })
  fromGroupId!: string;

  @ApiProperty({ format: 'uuid', description: 'Группа назначения' })
  toGroupId!: string;

  @ApiProperty({
    type: [GroupStudentDto],
    description: 'Членства в группе назначения — уже действующие',
  })
  students!: GroupStudentDto[];

  @ApiProperty({ example: 8, description: 'Сколько студентов осталось учиться в прежней группе' })
  enrolledCount!: number;
}

/** Ответ на исключение из состава — чтобы интерфейс мог назвать убранного. */
export class GroupStudentRemovedDto {
  @ApiProperty({ format: 'uuid' })
  groupId!: string;

  @ApiProperty({ format: 'uuid' })
  studentId!: string;

  @ApiProperty({ example: 'Каримова Нигина' })
  fullName!: string;

  @ApiProperty({ example: 11, description: 'Сколько студентов учится в группе после исключения' })
  enrolledCount!: number;
}
