import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Gender, LeadType } from '@prisma/client';

/** Именованная ссылка: курс, филиал или купон. */
export class LeadRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Frontend-разработка' })
  name!: string;
}

/** UTM-метки рекламной ссылки (ТЗ 5.7). */
export class LeadUtmDto {
  @ApiPropertyOptional({ nullable: true, example: 'instagram' })
  source!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'cpc' })
  medium!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'osen-2026' })
  campaign!: string | null;
}

/** Во что превратилось обращение (ТЗ 5.7: «Transfer в студенты»). */
export class LeadConversionDto {
  @ApiProperty({
    example: false,
    description:
      'Переведён ли лид в студенты. Отдельной колонкой флаг не хранится — переведён ' +
      'тот, у кого есть ссылка на профиль (то же решение, что с сертификатом, 0026).',
  })
  converted!: boolean;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Профиль студента, заведённый из этого обращения.',
  })
  studentId!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2026-09-02T08:30:00.000Z' })
  convertedAt!: string | null;
}

/** Лид / клиент (ТЗ 5.7). */
export class LeadDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Нигина' })
  firstName!: string;

  @ApiProperty({ example: 'Каримова' })
  lastName!: string;

  @ApiProperty({ example: '+992901234567' })
  phone!: string;

  @ApiPropertyOptional({ nullable: true, example: 'nigina@mail.tj' })
  email!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '2004-05-17' })
  birthDate!: string | null;

  @ApiPropertyOptional({ enum: Gender, nullable: true })
  gender!: Gender | null;

  @ApiPropertyOptional({ nullable: true, example: 'студент' })
  occupation!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-09',
    description: '«Месяц записи» из ТЗ 5.7.',
  })
  enrollMonth!: string | null;

  @ApiPropertyOptional({
    type: LeadRefDto,
    nullable: true,
    description: 'Интересующий курс (ТЗ 5.7).',
  })
  course!: LeadRefDto | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '18:30',
    description: '«Время урока» из ТЗ 5.7 — желаемое время занятий.',
  })
  lessonTime!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Просила перезвонить после 18:00' })
  notes!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Instagram',
    description: '«Referral source» из ТЗ 5.7.',
  })
  source!: string | null;

  @ApiProperty({ type: LeadUtmDto })
  utm!: LeadUtmDto;

  @ApiPropertyOptional({ type: LeadRefDto, nullable: true, description: 'Обещанный купон.' })
  coupon!: LeadRefDto | null;

  @ApiPropertyOptional({ type: LeadRefDto, nullable: true, description: 'Филиал записи (ТЗ 3.3).' })
  branch!: LeadRefDto | null;

  @ApiProperty({
    enum: LeadType,
    description: '`LEAD` — пришёл, `CLIENT` — после бесплатного пробного дня (ТЗ 5.7).',
  })
  type!: LeadType;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-08-20T12:00:00.000Z',
    description: 'Когда обращение стало клиентом. Проставляется системой при смене типа.',
  })
  becameClientAt!: string | null;

  @ApiProperty({ type: LeadConversionDto })
  conversion!: LeadConversionDto;

  @ApiProperty({ example: '2026-08-15T10:00:00.000Z', description: 'Когда обращение завели.' })
  createdAt!: string;
}

/**
 * Лид вместе с подсказкой о прежних обращениях с тем же номером.
 *
 * Телефон лида не уникален (одно обращение может повториться), поэтому отказа
 * здесь нет — но и молчать нельзя: оператор должен видеть, что этот человек
 * уже звонил, иначе он заведёт третью карточку и посчитает её новым лидом.
 */
export class CreatedLeadDto extends LeadDto {
  @ApiProperty({
    example: 1,
    description: 'Сколько **других** обращений с этим же номером уже есть. `0` — обращение первое.',
  })
  duplicatePhoneCount!: number;
}

/** Ответ на удаление лида. */
export class LeadDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Каримова Нигина' })
  name!: string;
}

/** Одно переведённое обращение (ТЗ 5.7: «Transfer в студенты»). */
export class TransferredLeadDto {
  @ApiProperty({ format: 'uuid' })
  leadId!: string;

  @ApiProperty({ example: 'Каримова Нигина' })
  name!: string;

  @ApiProperty({ format: 'uuid', description: 'Профиль студента, к которому привязано обращение.' })
  studentId!: string;

  @ApiProperty({
    enum: ['created', 'linked'],
    example: 'created',
    description:
      '`created` — профиль заведён этим переводом; `linked` — студент с таким телефоном ' +
      'уже был, и обращение привязано к нему. Второй профиль не заводится: `Student.phone` ' +
      'уникален. Действие названо явно, чтобы «перевели пятерых» и «завели пять карточек» ' +
      'не путались между собой.',
  })
  action!: 'created' | 'linked';
}

/** Результат перевода пачки (ТЗ 5.7). */
export class LeadsTransferredDto {
  @ApiProperty({ type: [TransferredLeadDto] })
  transferred!: TransferredLeadDto[];

  @ApiProperty({ example: 2, description: 'Сколько профилей заведено этим переводом.' })
  created!: number;

  @ApiProperty({ example: 1, description: 'Сколько обращений привязано к существующим профилям.' })
  linked!: number;
}
