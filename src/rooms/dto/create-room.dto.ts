import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { trimString } from '../../common';

/** Верхние границы — защита от опечатки вроде «вместимость 100000». */
const MAX_CAPACITY = 1000;
const MAX_FLOOR = 100;

/** Создание аудитории (ТЗ 5.10: Room — источник поля «аудитория» в расписании). */
export class CreateRoomDto {
  @ApiProperty({ format: 'uuid', description: 'Филиал, которому принадлежит аудитория (ТЗ 3.3)' })
  @IsUUID()
  branchId!: string;

  @ApiProperty({
    example: '101',
    minLength: 1,
    maxLength: 60,
    description: 'Название или номер. Уникально внутри филиала, без учёта регистра.',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @ApiPropertyOptional({ example: 16, minimum: 1, maximum: MAX_CAPACITY })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_CAPACITY)
  capacity?: number;

  @ApiPropertyOptional({ example: 2, minimum: -5, maximum: MAX_FLOOR })
  @IsOptional()
  @IsInt()
  @Min(-5)
  @Max(MAX_FLOOR)
  floor?: number;

  @ApiPropertyOptional({ maxLength: 300, description: 'Описание. Пустая строка очищает поле.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional({ enum: DirectoryStatus, default: DirectoryStatus.ACTIVE })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;
}
