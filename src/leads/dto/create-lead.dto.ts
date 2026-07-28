import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Gender, LeadType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { normalizeEmail, trimString } from '../../common';

/** Дата рождения либо пустая строка, стирающая её (как у карточки студента, 0014). */
const OPTIONAL_ISO_DATE = /^$|^\d{4}-\d{2}-\d{2}$/;

/** Месяц записи либо пустая строка, стирающая его. */
const OPTIONAL_ISO_MONTH = /^$|^\d{4}-\d{2}$/;

/** Желаемое время урока либо пустая строка, стирающая его. */
const OPTIONAL_DAY_TIME = /^$|^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Создание лида (ТЗ 5.7).
 *
 * Поля перечислены ровно по ТЗ: «ФИО, телефон, email, дата рождения, пол,
 * occupation, месяц записи, курс, время урока, notes, UTM/referral source,
 * купон, тип Lead/Client».
 *
 * `becameClientAt` в форме нет: дату перехода в клиенты проставляет система
 * при смене типа — введённая руками, она разошлась бы с самим событием.
 * `convertedStudentId` тоже нет: перевод в студенты делает отдельное действие
 * (`POST /leads/transfer`, ТЗ 5.7), а не сохранение карточки.
 */
export class CreateLeadDto {
  @ApiProperty({ example: 'Нигина', minLength: 2, maxLength: 100 })
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  firstName!: string;

  @ApiProperty({ example: 'Каримова', minLength: 2, maxLength: 100 })
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  lastName!: string;

  @ApiProperty({
    example: '+992 90 123-45-67',
    description:
      'Телефон, приводится к E.164 (ТЗ 3.1). **Не уникален**: один человек может ' +
      'обратиться дважды, и это два обращения, а не дубликат. Сервис возвращает ' +
      'подсказку о прежних обращениях с тем же номером, но не отказывает.',
  })
  @Transform(trimString)
  @IsString()
  @MaxLength(30)
  phone!: string;

  @ApiPropertyOptional({ example: 'nigina@mail.tj', maxLength: 200 })
  @IsOptional()
  @Transform(normalizeEmail)
  @IsString()
  @MaxLength(200)
  // Пустая строка очищает поле, поэтому проверка формата к ней не применяется.
  @ValidateIf((_, value: unknown) => value !== '')
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    example: '2004-05-17',
    description: 'Дата рождения `YYYY-MM-DD`. Пустая строка очищает поле.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(OPTIONAL_ISO_DATE, { message: 'birthDate должна быть датой в формате YYYY-MM-DD' })
  birthDate?: string;

  @ApiPropertyOptional({ enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @ApiPropertyOptional({
    example: 'студент',
    maxLength: 200,
    description: '«Occupation» из ТЗ 5.7 — род занятий. Пустая строка очищает поле.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  occupation?: string;

  @ApiPropertyOptional({
    example: '2026-09',
    description:
      '«Месяц записи» из ТЗ 5.7 — на какой месяц человек хочет записаться, `YYYY-MM`. ' +
      'Пустая строка очищает поле.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(OPTIONAL_ISO_MONTH, { message: 'enrollMonth: ожидается месяц в формате YYYY-MM' })
  enrollMonth?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Интересующий курс (ТЗ 5.7). Пустая строка снимает привязку.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  // Пустая строка снимает ссылку, поэтому `@IsUUID` к ней не применяется —
  // иначе поставленный по ошибке курс нельзя было бы убрать через `PUT`
  // (та же ловушка, что с `roomId` слота в сессии 0011).
  @ValidateIf((_, value: unknown) => value !== '')
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional({
    example: '18:30',
    description:
      '«Время урока» из ТЗ 5.7 — желаемое время занятий, `HH:MM`. Пустая строка ' + 'очищает поле.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(OPTIONAL_DAY_TIME, { message: 'lessonTime: ожидается время в формате HH:MM' })
  lessonTime?: string;

  @ApiPropertyOptional({ maxLength: 2000, description: 'Пустая строка очищает поле.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({
    example: 'Instagram',
    maxLength: 200,
    description:
      '«Referral source» из ТЗ 5.7 — как узнал о центре или кто порекомендовал. ' +
      'По нему же группируется отчёт по лидам (ТЗ 5.2).',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  source?: string;

  @ApiPropertyOptional({ example: 'instagram', maxLength: 200, description: 'UTM-метка `source`.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  utmSource?: string;

  @ApiPropertyOptional({ example: 'cpc', maxLength: 200, description: 'UTM-метка `medium`.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  utmMedium?: string;

  @ApiPropertyOptional({
    example: 'osen-2026',
    maxLength: 200,
    description: 'UTM-метка `campaign`.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  utmCampaign?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Обещанный купон (ТЗ 5.7). Применение купона к оплате отложено из v1 (ТЗ §6) — ' +
      'здесь он только помечает, с какой скидкой человека приглашали. Пустая строка ' +
      'снимает привязку.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @ValidateIf((_, value: unknown) => value !== '')
  @IsUUID()
  couponId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Филиал, в который записывается (ТЗ 3.3). Пустая строка снимает привязку.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @ValidateIf((_, value: unknown) => value !== '')
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    enum: LeadType,
    default: LeadType.LEAD,
    description:
      'Стадия обращения (ТЗ 5.7): `LEAD` — пришёл, `CLIENT` — после бесплатного ' +
      'пробного дня. Дату перехода (`becameClientAt`) проставляет система.',
  })
  @IsOptional()
  @IsEnum(LeadType)
  type?: LeadType;
}
