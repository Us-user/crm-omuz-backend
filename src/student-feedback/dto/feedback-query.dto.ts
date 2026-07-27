import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/**
 * Поле сортировки заметок. Перечисление из одного значения, а не свободная
 * строка базового DTO: иначе `sort=text` дошёл бы до `orderBy` Prisma и вернулся
 * ошибкой БД (500) — та же ловушка, что закрыта в остальных списках проекта.
 */
export enum FeedbackSortField {
  CreatedAt = 'createdAt',
}

/** Лента заметок о студенте (ТЗ 5.3). */
export class FeedbackQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: FeedbackSortField, default: FeedbackSortField.CreatedAt })
  @IsOptional()
  @IsEnum(FeedbackSortField)
  override sort: FeedbackSortField = FeedbackSortField.CreatedAt;

  // Заметки читают лентой, свежие сверху, — поэтому направление по умолчанию
  // обратное, в отличие от списков людей и справочников.
  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Desc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Только заметки этого сотрудника — «что писал ментор группы».',
  })
  @IsOptional()
  @IsUUID()
  authorId?: string;
}
