import { ApiPropertyOptional } from '@nestjs/swagger';
import { ParentRelation } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/**
 * Поля, по которым разрешено сортировать список родителей. Перечисление, а не
 * свободная строка из `PaginationQueryDto`: иначе значение дошло бы до `orderBy`
 * Prisma и вернулось ошибкой БД (500) на первом же неизвестном поле.
 */
export enum StudentParentSortField {
  /** «Фамилия, имя» — как в остальных списках людей проекта. */
  Name = 'name',
  /** Порядок добавления: первым обычно вводят того, кому звонят. */
  CreatedAt = 'createdAt',
}

/** Родители студента (ТЗ 4: Parent/Guardian). */
export class StudentParentQueryDto extends PaginationQueryDto {
  // По умолчанию — порядок добавления, а не алфавит: родителей у студента
  // единицы, и «кого записали первым» здесь осмысленнее фамилии. У родителя
  // к тому же может не быть имени вовсе (запись из регистрации).
  @ApiPropertyOptional({
    enum: StudentParentSortField,
    default: StudentParentSortField.CreatedAt,
  })
  @IsOptional()
  @IsEnum(StudentParentSortField)
  override sort: StudentParentSortField = StudentParentSortField.CreatedAt;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({
    enum: ParentRelation,
    description: 'Только родители с этой степенью родства.',
  })
  @IsOptional()
  @IsEnum(ParentRelation)
  relation?: ParentRelation;
}
