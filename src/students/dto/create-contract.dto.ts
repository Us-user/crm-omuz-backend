import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContractStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateContractDto {
  @ApiProperty({ description: 'Уникальный номер договора', example: 'ONT-2026-001' })
  @IsString()
  @IsNotEmpty()
  contractNumber: string;

  @ApiProperty({
    description: 'Название договора',
    example: 'Договор на оказание образовательных услуг',
  })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ description: 'Дата заключения договора (YYYY-MM-DD)', example: '2026-08-01' })
  @IsDateString()
  issuedAt: string;

  @ApiPropertyOptional({
    description: 'Дата окончания действия (YYYY-MM-DD)',
    example: '2027-08-01',
  })
  @IsOptional()
  @IsDateString()
  validUntil?: string;

  @ApiPropertyOptional({ enum: ContractStatus, default: ContractStatus.ACTIVE })
  @IsOptional()
  @IsEnum(ContractStatus)
  status?: ContractStatus;

  @ApiPropertyOptional({ description: 'Примечания' })
  @IsOptional()
  @IsString()
  notes?: string;
}
