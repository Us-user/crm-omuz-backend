import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { trimString } from '../../common';

/** Создание филиала (ТЗ 5.17: город, район, адрес, телефон, статус). */
export class CreateBranchDto {
  @ApiProperty({
    example: 'Sadbarg',
    minLength: 2,
    maxLength: 100,
    description: 'Название филиала. Уникально без учёта регистра.',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: 'Душанбе', maxLength: 100 })
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  city!: string;

  @ApiPropertyOptional({
    example: 'Сино',
    maxLength: 100,
    description: 'Район города. Пустая строка очищает поле.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(100)
  district?: string;

  @ApiProperty({ example: 'ул. Рудаки, 105', maxLength: 300 })
  @Transform(trimString)
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  address!: string;

  @ApiPropertyOptional({
    example: '+992 37 221-11-22',
    description: 'Телефон филиала. Приводится к E.164 (ТЗ 3.1).',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ maxLength: 500, description: 'Описание. Пустая строка очищает поле.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ enum: DirectoryStatus, default: DirectoryStatus.ACTIVE })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;
}
