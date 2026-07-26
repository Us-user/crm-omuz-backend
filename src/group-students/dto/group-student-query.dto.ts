import { ApiPropertyOptional } from '@nestjs/swagger';
import { GroupStudentStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/**
 * Поля сортировки состава группы. Перечисление, а не свободная строка
 * из `PaginationQueryDto`: иначе значение дошло бы до `orderBy` Prisma
 * и вернулось ошибкой БД (500) на первом неизвестном поле.
 */
export enum GroupStudentSortField {
  /** По фамилии и имени студента — так список читают на карточке группы. */
  Name = 'name',
  EnrolledAt = 'enrolledAt',
}

/** Состав группы (ТЗ 3.5, 5.5). */
export class GroupStudentQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: GroupStudentSortField, default: GroupStudentSortField.Name })
  @IsOptional()
  @IsEnum(GroupStudentSortField)
  override sort: GroupStudentSortField = GroupStudentSortField.Name;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({
    enum: GroupStudentStatus,
    description:
      'Статус членства в группе. Без фильтра список отдаёт и закрытые членства: ' +
      'состав группы — это её история, а не только те, кто учится сейчас. ' +
      '`LEFT` — секция «Left course» карточки группы (ТЗ 5.5, 5.12).',
  })
  @IsOptional()
  @IsEnum(GroupStudentStatus)
  status?: GroupStudentStatus;
}
