import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PageQueryDto, SortOrder } from '../../common';

/** Единственное поле сортировки рейтинга: он и есть порядок по баллу. */
export enum LeaderSortField {
  AverageScore = 'averageScore',
}

/**
 * Рейтинг центра (ТЗ 5.13: «топ-3, список, корона = №1. Фильтр по группе/курсу»).
 *
 * Наследует `PageQueryDto`, а не `PaginationQueryDto`: искать в рейтинге нечем —
 * это упорядоченный список людей, и поиск по имени решает `GET /students`.
 * `search`, который есть в OpenAPI и молча ничего не делает, хуже отсутствующего
 * (правило сессий 0017–0018).
 *
 * `sort` сужен до одного значения по той же причине, по которой он сужен везде:
 * свободная строка дошла бы до `orderBy` Prisma и вернулась ошибкой БД (500).
 * `order` при этом работает в обе стороны: `desc` — лидеры сверху, `asc` —
 * отстающие. Второе не украшение: категория `Black list` (ТЗ 5.5) существует
 * ровно затем, чтобы этих студентов находить.
 */
export class LeadersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: LeaderSortField,
    default: LeaderSortField.AverageScore,
    description: 'Только по общему баллу: другого порядка у рейтинга нет.',
  })
  @IsOptional()
  @IsEnum(LeaderSortField)
  override sort: LeaderSortField = LeaderSortField.AverageScore;

  @ApiPropertyOptional({
    enum: SortOrder,
    default: SortOrder.Desc,
    description: '`desc` — лидеры сверху (по умолчанию), `asc` — отстающие сверху.',
  })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Рейтинг внутри группы: балл считается **по неделям этой группы**, а не общий. ' +
      'Так же устроены счётчики категорий в карточке группы (ТЗ 5.5) — иначе цифры ' +
      'двух экранов про одну группу разошлись бы.',
  })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Рейтинг внутри курса: балл считается по неделям групп этого курса.',
  })
  @IsOptional()
  @IsUUID()
  courseId?: string;
}
