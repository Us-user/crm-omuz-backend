import { ApiPropertyOptional } from '@nestjs/swagger';
import { GroupMentorRole } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/**
 * Поля сортировки списка менторов. Перечисление, а не свободная строка
 * из `PaginationQueryDto`: иначе значение дошло бы до `orderBy` Prisma
 * и вернулось ошибкой БД (500) на первом неизвестном поле.
 */
export enum GroupMentorSortField {
  /** По фамилии и имени сотрудника — так список читают на карточке группы. */
  Name = 'name',
  AssignedAt = 'assignedAt',
}

/** Менторы группы (ТЗ 3.5, 5.5). */
export class GroupMentorQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: GroupMentorSortField, default: GroupMentorSortField.Name })
  @IsOptional()
  @IsEnum(GroupMentorSortField)
  override sort: GroupMentorSortField = GroupMentorSortField.Name;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({
    enum: GroupMentorRole,
    description: 'Только менторы этой роли: Teaching (ведёт) или Support (помогает)',
  })
  @IsOptional()
  @IsEnum(GroupMentorRole)
  role?: GroupMentorRole;
}
