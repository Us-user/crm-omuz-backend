import { ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/** Поля, по которым разрешено сортировать список купонов. */
export enum CouponSortField {
  Name = 'name',
  Amount = 'amount',
  /** Конец периода: «что скоро закончится» — обычный вопрос к акциям. */
  ValidTo = 'validTo',
  CreatedAt = 'createdAt',
}

/** Тот же разбор, что у `hasAccount` в списке студентов (0014). */
const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/**
 * Список купонов (ТЗ 5.7).
 *
 * `sort` сужен до перечисления, как во всех списках проекта: свободная строка
 * из базового DTO попала бы в `orderBy` Prisma и вернулась бы ошибкой БД.
 */
export class CouponQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: CouponSortField, default: CouponSortField.Name })
  @IsOptional()
  @IsEnum(CouponSortField)
  override sort: CouponSortField = CouponSortField.Name;

  // Справочник читают по алфавиту — как филиалы и позиции.
  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({ enum: DirectoryStatus, description: 'Active/Inactive из ТЗ 5.7.' })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Купоны, действующие на этот курс. Купоны «на все курсы» (с пустым набором) ' +
      'в выборку тоже попадают — иначе фильтр отвечал бы не на вопрос «чем можно ' +
      'воспользоваться на этом курсе», а на вопрос «что перечислено поимённо».',
  })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional({
    description:
      'Действует ли купон сегодня: `true` — только `ACTIVE` внутри периода, ' +
      '`false` — выключенные и те, чей период не наступил или прошёл.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  currentlyValid?: boolean;
}
