import { ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/**
 * Поля сортировки справочника уровней. Перечисление, а не свободная строка
 * из `PaginationQueryDto`: иначе значение дошло бы до `orderBy` Prisma
 * и вернулось ошибкой БД (500) на первом же неизвестном поле.
 */
export enum MentorLevelSortField {
  Name = 'name',
  /** Лестницу читают по ставке — от неё зависит, куда человек растёт. */
  HourlyRate = 'hourlyRate',
  CreatedAt = 'createdAt',
}

/** Список ступеней справочника (ТЗ 5.14). */
export class MentorLevelQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: MentorLevelSortField, default: MentorLevelSortField.HourlyRate })
  @IsOptional()
  @IsEnum(MentorLevelSortField)
  override sort: MentorLevelSortField = MentorLevelSortField.HourlyRate;

  // Лестница читается снизу вверх: младшая ступень первой.
  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({ enum: DirectoryStatus, description: 'Состояние ступени' })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;
}
