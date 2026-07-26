import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export enum SortOrder {
  Asc = 'asc',
  Desc = 'desc',
}

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

const toInt = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Базовые query-параметры списков (ТЗ 3.5): пагинация, поиск, сортировка.
 * Доменные фильтры добавляются наследованием в модулях.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Номер страницы, с 1', minimum: 1, default: DEFAULT_PAGE })
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  page: number = DEFAULT_PAGE;

  @ApiPropertyOptional({
    description: 'Размер страницы',
    minimum: 1,
    maximum: MAX_LIMIT,
    default: DEFAULT_LIMIT,
  })
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit: number = DEFAULT_LIMIT;

  @ApiPropertyOptional({ description: 'Строка полнотекстового поиска' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: 'Поле сортировки' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  sort?: string;

  @ApiPropertyOptional({
    description: 'Направление сортировки',
    enum: SortOrder,
    default: SortOrder.Desc,
  })
  @IsOptional()
  @IsEnum(SortOrder)
  order: SortOrder = SortOrder.Desc;

  /** Смещение для Prisma `skip`. */
  get skip(): number {
    return (this.page - 1) * this.limit;
  }

  /** Лимит для Prisma `take`. */
  get take(): number {
    return this.limit;
  }
}
