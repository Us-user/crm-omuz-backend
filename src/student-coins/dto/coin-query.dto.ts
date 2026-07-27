import { ApiPropertyOptional } from '@nestjs/swagger';
import { CoinSource } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { PageQueryDto, SortOrder } from '../../common';

/**
 * Поля сортировки истории коинов. Перечисление, а не свободная строка:
 * иначе значение дошло бы до `orderBy` Prisma и вернулось ошибкой БД (500).
 */
export enum CoinSortField {
  CreatedAt = 'createdAt',
  Amount = 'amount',
}

/**
 * История начислений коинов (ТЗ 3.5, 5.9).
 *
 * Наследуется от `PageQueryDto`, а не от `PaginationQueryDto`: искать
 * в истории коинов нечего — у строки есть сумма, дата и причина, и полнотекстовый
 * поиск по причине не тот вопрос, который задают этому экрану.
 */
export class CoinQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: CoinSortField, default: CoinSortField.CreatedAt })
  @IsOptional()
  @IsEnum(CoinSortField)
  override sort: CoinSortField = CoinSortField.CreatedAt;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Desc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({
    enum: CoinSource,
    description:
      'Откуда начисление: `MANUAL` — вручную сотрудником, `WEEK_RESULT` — ' +
      'автоматически по итогам недели журнала (ТЗ 5.9).',
  })
  @IsOptional()
  @IsEnum(CoinSource)
  source?: CoinSource;
}
