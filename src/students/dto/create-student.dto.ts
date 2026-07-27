import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Gender, StudentStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { normalizeEmail, trimString } from '../../common';

/**
 * Сколько дополнительных телефонов принимается (ТЗ 5.3: «телефон + доп. телефоны»).
 * Свой номер, рабочий, второй родитель — дальше список перестаёт быть контактами.
 */
export const MAX_EXTRA_PHONES = 5;

/** Дата рождения либо пустая строка, стирающая её (как у сроков группы, сессия 0008). */
const OPTIONAL_ISO_DATE = /^$|^\d{4}-\d{2}-\d{2}$/;

/**
 * Создание студента администратором (ТЗ 5.3: форма карточки).
 *
 * Аккаунта здесь нет намеренно: ТЗ 5.3 называет его опциональным и выдаёт
 * отдельным действием «Invite». Профиль заводится раньше логина — человек может
 * прийти по записи и получить доступ позже.
 *
 * Телефона родителя здесь тоже нет: форма ТЗ 5.3 его не перечисляет, а контакты
 * родителей ведёт `POST /students/{id}/parents` (ТЗ 4). Поле в этой форме стало бы
 * вторым способом записать тот же контакт — и разошлось бы со списком родителей.
 */
export class CreateStudentDto {
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
      'Контактный телефон. Уникален среди студентов и приводится к E.164 (ТЗ 3.1). ' +
      'Логином он становится только при выдаче аккаунта — это разные поля (решение сессии 0002).',
  })
  @Transform(trimString)
  @IsString()
  @MaxLength(30)
  phone!: string;

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

  @ApiPropertyOptional({ maxLength: 300, description: 'Пустая строка очищает поле.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(300)
  address?: string;

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
    type: [String],
    maxItems: MAX_EXTRA_PHONES,
    example: ['+992 92 111-22-33'],
    description:
      'Дополнительные телефоны (ТЗ 5.3). Каждый приводится к E.164, повторы отбрасываются. ' +
      'Пустой массив очищает список.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_EXTRA_PHONES)
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  extraPhones?: string[];

  @ApiPropertyOptional({
    example: '@nigina',
    maxLength: 100,
    description: 'Telegram — ник или ссылка. Пустая строка очищает поле.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(100)
  telegram?: string;

  @ApiPropertyOptional({
    example: 'https://cdn.omuz.tj/students/nigina.jpg',
    maxLength: 500,
    description:
      'Ссылка на фото во внешнем хранилище (решение сессии 0009). Пустая строка очищает.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  @ValidateIf((_, value: unknown) => value !== '')
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  photoUrl?: string;

  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'Заметки о студенте (ТЗ 5.3). Пустая строка очищает поле.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Филиал студента (ТЗ 3.3). Пустая строка отвязывает от филиала.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  // Пустая строка снимает привязку, поэтому `@IsUUID` к ней не применяется —
  // иначе поставленный по ошибке филиал нельзя было бы убрать через `PUT`
  // (та же ловушка, что с `roomId` слота в сессии 0011).
  @ValidateIf((_, value: unknown) => value !== '')
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    enum: StudentStatus,
    default: StudentStatus.ACTIVE,
    description:
      'Статус студента (ТЗ 5.3). Пересчитывается автоматически при изменении состава групп; ' +
      '`BLOCK` автоматика не перебивает.',
  })
  @IsOptional()
  @IsEnum(StudentStatus)
  status?: StudentStatus;
}
