import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { DirectoryStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

import { PaginationQueryDto, SortOrder, trimString } from '../../common';

/** По чему сортируется справочник способов оплаты. */
export enum PaymentTypeSortField {
  /** По названию — по умолчанию: это справочник, его читают алфавитом. */
  Name = 'name',
  CreatedAt = 'createdAt',
}

/** Способ оплаты (ТЗ 5.16: «тип Cash/Alif»). */
export class PaymentTypeDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Alif' })
  name!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Перевод через приложение Alif Mobi' })
  description!: string | null;

  @ApiProperty({
    enum: DirectoryStatus,
    description:
      'Выведенным из работы способом новые платежи не принимаются (422), но прошлые ' +
      'остаются — та же асимметрия, что у ступени ментора (0021) и сотрудника в менторах (0010).',
  })
  status!: DirectoryStatus;

  @ApiProperty({
    example: 12,
    description: 'Сколько платежей принято этим способом. Способ с платежами не удаляется (409).',
  })
  transactionsCount!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class PaymentTypeDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Alif' })
  name!: string;
}

export class CreatePaymentTypeDto {
  @ApiProperty({ example: 'Alif', minLength: 2, maxLength: 100 })
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ maxLength: 1000, description: 'Пустая строка очищает поле.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ enum: DirectoryStatus, default: DirectoryStatus.ACTIVE })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;
}

export class UpdatePaymentTypeDto extends PartialType(CreatePaymentTypeDto) {}

/** Список способов оплаты. */
export class PaymentTypesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PaymentTypeSortField, default: PaymentTypeSortField.Name })
  @IsOptional()
  @IsEnum(PaymentTypeSortField)
  override sort: PaymentTypeSortField = PaymentTypeSortField.Name;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({ enum: DirectoryStatus, description: 'Только действующие или выведенные.' })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;
}
