import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EmployeeStatus, Gender } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
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
 * Сколько позиций принимается в одном запросе. Столько же, сколько в назначении
 * ролей Фазы 2 (`MAX_ROLES_PER_REQUEST`): списки пишут в одну таблицу, и разные
 * потолки читались бы как разные правила.
 */
export const MAX_POSITIONS_PER_EMPLOYEE = 20;

/** Дата либо пустая строка, стирающая её (как у сроков группы, сессия 0008). */
const OPTIONAL_ISO_DATE = /^$|^\d{4}-\d{2}-\d{2}$/;

/**
 * Создание сотрудника (ТЗ 5.14: форма карточки «Employer»).
 *
 * Аккаунта здесь нет: ТЗ 5.14 прямо называет его опциональным — ровно как
 * у студента (ТЗ 5.3). Профиль ментора заводится раньше логина, а логин
 * появляется переводом студента (ТЗ 3.1) или сид-скриптом.
 */
export class CreateEmployeeDto {
  @ApiProperty({ example: 'Фаррух', minLength: 2, maxLength: 100 })
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  firstName!: string;

  @ApiProperty({ example: 'Раҳимов', minLength: 2, maxLength: 100 })
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  lastName!: string;

  @ApiPropertyOptional({
    example: 'Саидович',
    maxLength: 100,
    description: 'Отчество. Пустая строка очищает поле.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(100)
  middleName?: string;

  @ApiProperty({
    example: '+992 90 123-45-67',
    description:
      'Контактный телефон. Уникален среди сотрудников и приводится к E.164 (ТЗ 3.1). ' +
      'Логином он становится только вместе с аккаунтом — это разные поля (решение сессии 0002).',
  })
  @Transform(trimString)
  @IsString()
  @MaxLength(30)
  phone!: string;

  @ApiPropertyOptional({
    example: '1994-03-12',
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

  @ApiPropertyOptional({ example: 'farrukh@omuz.tj', maxLength: 200 })
  @IsOptional()
  @Transform(normalizeEmail)
  @IsString()
  @MaxLength(200)
  // Пустая строка очищает поле, поэтому проверка формата к ней не применяется.
  @ValidateIf((_, value: unknown) => value !== '')
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    example: '@farrukh',
    maxLength: 100,
    description: 'Telegram — ник или ссылка. Пустая строка очищает поле.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(100)
  telegram?: string;

  @ApiPropertyOptional({
    example: 'https://cdn.omuz.tj/employees/farrukh.jpg',
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
    example: '5 лет коммерческой разработки, 2 года преподавания',
    maxLength: 2000,
    description: 'Поле «Experience» формы ТЗ 5.14 — свободный текст. Пустая строка очищает.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(2000)
  experience?: string;

  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'Поле «Description» формы ТЗ 5.14. Пустая строка очищает поле.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Филиал сотрудника (ТЗ 3.3, 5.14). Пустая строка отвязывает от филиала.',
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
    example: '2026-01-15',
    description: 'Дата приёма на работу `YYYY-MM-DD`. Пустая строка очищает поле.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(OPTIONAL_ISO_DATE, { message: 'hiredAt должна быть датой в формате YYYY-MM-DD' })
  hiredAt?: string;

  @ApiPropertyOptional({
    enum: EmployeeStatus,
    default: EmployeeStatus.ACTIVE,
    description:
      'Штатный статус. `INACTIVE` («выведен из штата») **закрывает вход**: ' +
      'аккаунт блокируется той же транзакцией, а сессии гасятся. Возврат в `ACTIVE` ' +
      'вход открывает.',
  })
  @IsOptional()
  @IsEnum(EmployeeStatus)
  status?: EmployeeStatus;

  @ApiPropertyOptional({
    type: [String],
    maxItems: MAX_POSITIONS_PER_EMPLOYEE,
    description:
      'Позиции сотрудника (ТЗ 5.14: «Position — мультивыбор»). Заменяют набор целиком: ' +
      'экран сохраняет весь мультивыбор, и при слиянии снять позицию было бы нечем. ' +
      'Права сотрудника — объединение прав этих позиций (ТЗ 3.2), поэтому поле ' +
      '**дополнительно требует** `Permission.Administration.ManageUserRoles`: иначе право ' +
      'на карточку сотрудника стало бы правом раздать себе `Director`. ' +
      'Не переданное поле позиции не трогает.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_POSITIONS_PER_EMPLOYEE)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  positionIds?: string[];
}
