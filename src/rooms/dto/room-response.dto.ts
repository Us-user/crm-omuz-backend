import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus } from '@prisma/client';

/** Филиал аудитории — коротко, чтобы список не требовал второго запроса. */
export class RoomBranchDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sadbarg' })
  name!: string;
}

/** Аудитория (ТЗ 5.10). */
export class RoomDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '101' })
  name!: string;

  @ApiProperty({ type: RoomBranchDto })
  branch!: RoomBranchDto;

  @ApiPropertyOptional({ nullable: true, example: 16 })
  capacity!: number | null;

  @ApiPropertyOptional({ nullable: true, example: 2 })
  floor!: number | null;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiProperty({ enum: DirectoryStatus })
  status!: DirectoryStatus;

  @ApiProperty({ example: '2026-07-27T10:15:00.000Z' })
  createdAt!: string;
}

/** Ответ на удаление — чтобы интерфейс мог назвать удалённое. */
export class RoomDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '101' })
  name!: string;
}
