import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus, EmployeeStatus, Gender } from '@prisma/client';

/** Филиал, к которому приписан сотрудник (ТЗ 3.3). */
export class MentorBranchDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sadbarg' })
  name!: string;
}

/**
 * Позиция сотрудника (ТЗ 3.2: позиция и есть роль доступа).
 *
 * Прав каталога здесь нет: набор из 99 кодов в кабинете не нужен, а вот
 * ответ на вопрос «кто я в системе» — нужен, иначе сотрудник не понимает,
 * почему одни разделы ему открыты, а другие нет.
 */
export class MentorPositionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Mentor' })
  name!: string;
}

/**
 * Уровень ментора в текущем месяце вместе со ставкой (ТЗ 5.4: «уровень +
 * часовая ставка»; помесячная история — ТЗ 5.14).
 *
 * Месяц назван **явно**, а не подразумевается: значение зависит от того, когда
 * задан вопрос, и без месяца в ответе карточка отвечала бы по-разному первого
 * и тридцать первого числа без единого изменения данных (ровно та причина,
 * по которой сессия 0021 не стала класть уровень в `EmployeeDto`).
 *
 * `null` вместо уровня — законное состояние: месяц без записи означает,
 * что уровня не было, и предыдущий сюда не тянется (решение сессии 0021).
 */
export class MentorLevelDto {
  @ApiProperty({ example: '2026-07', description: 'Месяц, к которому относится уровень' })
  month!: string;

  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Senior mentor' })
  name!: string;

  @ApiProperty({
    example: 45,
    description:
      'Часовая ставка в сомони. Живёт в справочнике ступеней: её правка меняет ' +
      'расчёт за все месяцы, где проставлена эта ступень (решение сессии 0021).',
  })
  hourlyRate!: number;

  @ApiProperty({
    enum: DirectoryStatus,
    description: '`INACTIVE` — ступень выведена из справочника, но проставленный месяц остаётся',
  })
  status!: DirectoryStatus;
}

/**
 * Собственный профиль сотрудника (ТЗ 5.4, раздел «Profile»).
 *
 * Это **не** карточка «Employer» из админ-стороны: здесь нет данных аккаунта
 * (логин и статус входа) и нет служебной связи перевода Студент → Сотрудник.
 * Зато есть уровень и ставка текущего месяца — то, ради чего ТЗ 5.4 и называет
 * профиль ментора отдельным разделом.
 */
export class MentorProfileDto {
  @ApiProperty({ format: 'uuid', description: 'Идентификатор профиля сотрудника' })
  id!: string;

  @ApiProperty({ example: 'Фаррух' })
  firstName!: string;

  @ApiProperty({ example: 'Раҳимов' })
  lastName!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Азизович' })
  middleName!: string | null;

  @ApiProperty({ example: '+992901234567', description: 'Контактный телефон, E.164' })
  phone!: string;

  @ApiPropertyOptional({ nullable: true, example: '1992-03-14', description: 'YYYY-MM-DD' })
  birthDate!: string | null;

  @ApiPropertyOptional({ enum: Gender, nullable: true })
  gender!: Gender | null;

  @ApiPropertyOptional({ nullable: true })
  address!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'farrukh@omuz.tj' })
  email!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '@farrukh' })
  telegram!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'https://cdn.omuz.tj/employees/farrukh.jpg' })
  photoUrl!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '5 лет коммерческой разработки' })
  experience!: string | null;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiPropertyOptional({ type: MentorBranchDto, nullable: true })
  branch!: MentorBranchDto | null;

  @ApiProperty({
    enum: EmployeeStatus,
    description:
      'Статус в штате. `INACTIVE` в кабинете не встречается: выведенному из штата ' +
      'кабинет закрыт (403), как и вход (решение сессии 0020).',
  })
  status!: EmployeeStatus;

  @ApiPropertyOptional({ nullable: true, example: '2024-09-01', description: 'YYYY-MM-DD' })
  hiredAt!: string | null;

  @ApiProperty({ type: [MentorPositionDto], description: 'Позиции сотрудника (ТЗ 3.2)' })
  positions!: MentorPositionDto[];

  @ApiPropertyOptional({
    type: MentorLevelDto,
    nullable: true,
    description: 'Уровень и ставка текущего месяца; `null` — на этот месяц уровень не проставлен',
  })
  level!: MentorLevelDto | null;

  @ApiProperty({ example: '2026-07-27T10:15:00.000Z', description: 'Когда заведён профиль' })
  createdAt!: string;
}
