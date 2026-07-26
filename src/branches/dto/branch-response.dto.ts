import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus } from '@prisma/client';

/**
 * Карточка филиала (ТЗ 5.17). Счётчики отдаются и в списке: экран рисует
 * по ним график студентов по филиалам, и второй запрос за этим не нужен.
 */
export class BranchDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sadbarg' })
  name!: string;

  @ApiProperty({ example: 'Душанбе' })
  city!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Сино' })
  district!: string | null;

  @ApiProperty({ example: 'ул. Рудаки, 105' })
  address!: string;

  @ApiPropertyOptional({ nullable: true, example: '+992372211122', description: 'E.164' })
  phone!: string | null;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiProperty({ enum: DirectoryStatus })
  status!: DirectoryStatus;

  @ApiProperty({ example: 4, description: 'Сколько аудиторий в филиале' })
  roomsCount!: number;

  @ApiProperty({ example: 120, description: 'Сколько студентов закреплено за филиалом' })
  studentsCount!: number;

  @ApiProperty({ example: 9, description: 'Сколько сотрудников закреплено за филиалом' })
  employeesCount!: number;

  @ApiProperty({ example: '2026-07-27T10:15:00.000Z' })
  createdAt!: string;
}

/** Ответ на удаление — чтобы интерфейс мог назвать удалённое. */
export class BranchDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sadbarg' })
  name!: string;
}
