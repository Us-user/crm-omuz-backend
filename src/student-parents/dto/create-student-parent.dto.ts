import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ParentRelation } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { normalizeEmail, trimString } from '../../common';

/**
 * Добавление родителя или опекуна студенту (ТЗ 4: Parent/Guardian).
 *
 * Ключ здесь — **телефон**: запись родителя общая, и если человек с таким
 * номером уже заведён (например, вторым ребёнком или регистрацией по ТЗ 3.1),
 * он не дублируется, а привязывается к этому студенту.
 *
 * Имя и фамилия необязательны намеренно: регистрация собирает только номер,
 * и требовать здесь ФИО значило бы разойтись с тем, что уже лежит в базе.
 */
export class CreateStudentParentDto {
  @ApiProperty({
    example: '+992 90 765-43-21',
    description:
      'Телефон родителя. Приводится к E.164 и служит ключом записи: родитель ' +
      'с таким номером переиспользуется, а не заводится заново.',
  })
  @Transform(trimString)
  @IsString()
  @MaxLength(30)
  phone!: string;

  @ApiPropertyOptional({ example: 'Гулнора', minLength: 2, maxLength: 100 })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  // Пустая строка очищает поле, поэтому нижняя граница к ней не применяется.
  @ValidateIf((_, value: unknown) => value !== '')
  @MinLength(2)
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional({ example: 'Каримова', minLength: 2, maxLength: 100 })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @ValidateIf((_, value: unknown) => value !== '')
  @MinLength(2)
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional({ example: 'gulnora@mail.tj', maxLength: 200 })
  @IsOptional()
  @Transform(normalizeEmail)
  @IsString()
  @MaxLength(200)
  @ValidateIf((_, value: unknown) => value !== '')
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '@gulnora', maxLength: 100 })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(100)
  telegram?: string;

  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'Заметки о родителе: удобное время для звонка, договорённости.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({
    enum: ParentRelation,
    description:
      'Кем приходится студенту. Необязательно: регистрация (ТЗ 3.1) собирает только ' +
      'номер, и записи, заведённые ею, степени родства не знают. Пустая строка снимает.',
  })
  @IsOptional()
  @Transform(trimString)
  @ValidateIf((_, value: unknown) => value !== '')
  @IsEnum(ParentRelation)
  relation?: ParentRelation;
}
