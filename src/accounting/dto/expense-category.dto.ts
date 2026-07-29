import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { DirectoryStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

import { trimString } from '../../common';

/** Категория расхода (ТЗ 5.16: «Expenses: категории»). */
export class ExpenseCategoryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'НДС' })
  name!: string;

  @ApiPropertyOptional({ nullable: true, example: 'VAT (ТЗ 5.16)' })
  description!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: { id: 'uuid', name: 'Налоги' },
    description: 'Родительская категория. `null` — категория верхнего уровня.',
  })
  parent!: { id: string; name: string } | null;

  @ApiProperty({
    enum: DirectoryStatus,
    description:
      'По выведенной из работы категории новые расходы не проводятся (422), но уже ' +
      'проведённые её не теряют — та же асимметрия, что у способа оплаты (0029).',
  })
  status!: DirectoryStatus;

  @ApiProperty({
    example: 4,
    description: 'Сколько подкатегорий внутри. Только у верхнего уровня.',
  })
  childrenCount!: number;

  @ApiProperty({
    example: 17,
    description: 'Сколько расходов проведено по этой категории. Использованная не удаляется (409).',
  })
  expensesCount!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

/** Категория верхнего уровня вместе со своими подкатегориями. */
export class ExpenseCategoryTreeDto extends ExpenseCategoryDto {
  @ApiProperty({ type: [ExpenseCategoryDto] })
  children!: ExpenseCategoryDto[];
}

/**
 * Справочник целиком, деревом.
 *
 * **Не постраничный** — как каталог прав (0006): в справочнике из десятка
 * строк страница отрезала бы подкатегории от родителя, а «Tax» без своих
 * четырёх налогов не значит ничего. Отбор по статусу и поиску при этом
 * остаются: они сужают дерево, а не режут его на равные куски.
 */
export class ExpenseCategoryCatalogDto {
  @ApiProperty({ example: 8, description: 'Сколько категорий в выдаче, включая вложенные.' })
  total!: number;

  @ApiProperty({ type: [ExpenseCategoryTreeDto] })
  categories!: ExpenseCategoryTreeDto[];
}

export class ExpenseCategoryDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'НДС' })
  name!: string;
}

export class CreateExpenseCategoryDto {
  @ApiProperty({ example: 'Транспорт', minLength: 2, maxLength: 100 })
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ maxLength: 1000, description: 'Пустая строка очищает поле.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Родительская категория. Глубина ограничена **двумя** уровнями: подкатегорию ' +
      'нельзя вложить в подкатегорию (422).',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({ enum: DirectoryStatus, default: DirectoryStatus.ACTIVE })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;
}

/**
 * Правка категории. `parentId` пустой строкой поднимает категорию на верхний
 * уровень — то же правило пустой строки, что у аудитории слота (0011),
 * филиала студента (0014) и разнесения предоплаты (0029).
 */
export class UpdateExpenseCategoryDto extends PartialType(CreateExpenseCategoryDto) {
  @ApiPropertyOptional({
    description:
      'Родитель категории. Пустая строка поднимает её на верхний уровень. ' +
      'Категорию с подкатегориями вложить нельзя (422).',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  override parentId?: string;
}

/** Отбор справочника категорий. */
export class ExpenseCategoriesQueryDto {
  @ApiPropertyOptional({ enum: DirectoryStatus, description: 'Только действующие или выведенные.' })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;

  @ApiPropertyOptional({
    description:
      'Поиск по названию и описанию. Родитель остаётся в выдаче, если найдена ' +
      'его подкатегория: иначе она висела бы в дереве без ветки.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(200)
  search?: string;
}
