import { ApiPropertyOptional } from '@nestjs/swagger';
import { AvansStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Matches } from 'class-validator';

import { ISO_MONTH_PATTERN, PageQueryDto, SortOrder, trimString } from '../../common';

/**
 * Поля сортировки заявок. Перечисление, а не свободная строка: иначе значение
 * дошло бы до `orderBy` Prisma и вернулось ошибкой БД (500).
 */
export enum AvansSortField {
  CreatedAt = 'createdAt',
  Month = 'month',
  Amount = 'amount',
}

/**
 * Заявки сотрудника на аванс (ТЗ 5.14).
 *
 * Наследует `PageQueryDto`, а не `PaginationQueryDto`: искать в заявках нечем —
 * у строки есть сумма, месяц и статус, а полнотекстовый поиск по причине не тот
 * вопрос, который задают этому экрану. `search`, который есть в OpenAPI и молча
 * ничего не делает, хуже отсутствующего (правило сессий 0017–0018).
 *
 * Фильтры `from`/`to` заведены сверх перечня ТЗ — по той же причине, что
 * в истории уровней (0021): зарплата считается за период (ТЗ 5.16).
 */
export class AvansQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: AvansSortField, default: AvansSortField.CreatedAt })
  @IsOptional()
  @IsEnum(AvansSortField)
  override sort: AvansSortField = AvansSortField.CreatedAt;

  // Заявки читаются свежими сверху — как лента коинов, заметок и история уровней.
  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Desc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({
    enum: AvansStatus,
    description:
      '`PENDING` — ждёт рассмотрения, `APPROVED` — одобрена (становится `Prepaid` ' +
      'в расчёте месяца), `DENIED` — отклонена.',
  })
  @IsOptional()
  @IsEnum(AvansStatus)
  status?: AvansStatus;

  @ApiPropertyOptional({ example: '2026-01', description: 'С этого месяца зарплаты включительно' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(ISO_MONTH_PATTERN, { message: 'from должен быть месяцем в формате YYYY-MM' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-12', description: 'По этот месяц зарплаты включительно' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(ISO_MONTH_PATTERN, { message: 'to должен быть месяцем в формате YYYY-MM' })
  to?: string;
}
