import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Contract, ContractStatus } from '@prisma/client';

export class ContractDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  studentId: string;

  @ApiProperty()
  contractNumber: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  issuedAt: string;

  @ApiPropertyOptional()
  validUntil?: string;

  @ApiProperty({ enum: ContractStatus })
  status: ContractStatus;

  @ApiPropertyOptional()
  notes?: string;

  @ApiProperty()
  createdAt: string;

  static fromEntity(entity: Contract): ContractDto {
    return {
      id: entity.id,
      studentId: entity.studentId,
      contractNumber: entity.contractNumber,
      title: entity.title,
      issuedAt: entity.issuedAt.toISOString().split('T')[0],
      validUntil: entity.validUntil ? entity.validUntil.toISOString().split('T')[0] : undefined,
      status: entity.status,
      notes: entity.notes ?? undefined,
      createdAt: entity.createdAt.toISOString(),
    };
  }
}
