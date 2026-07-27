import { ApiPropertyOptional } from '@nestjs/swagger';
import { GroupStudentStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/**
 * Поля сортировки своих групп. Перечисление, а не свободная строка
 * из `PaginationQueryDto`: иначе значение дошло бы до `orderBy` Prisma
 * и вернулось ошибкой БД (500) на первом же неизвестном поле.
 */
export enum MeGroupSortField {
  /** Порядок зачисления: свежее членство почти всегда и есть действующее. */
  EnrolledAt = 'enrolledAt',
  /** По названию группы — когда групп несколько и их ищут глазами. */
  Name = 'name',
}

/** Свои группы (ТЗ 3.5, 5.3). */
export class MeGroupQueryDto extends PaginationQueryDto {
  // По умолчанию — свежие сверху: в кабинете первым нужен текущий курс,
  // а закрытые членства это история, которая читается ниже.
  @ApiPropertyOptional({ enum: MeGroupSortField, default: MeGroupSortField.EnrolledAt })
  @IsOptional()
  @IsEnum(MeGroupSortField)
  override sort: MeGroupSortField = MeGroupSortField.EnrolledAt;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Desc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({
    enum: GroupStudentStatus,
    description: 'Только членства с этим статусом. `ACTIVE` — «где я учусь сейчас».',
  })
  @IsOptional()
  @IsEnum(GroupStudentStatus)
  status?: GroupStudentStatus;
}
