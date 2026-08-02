import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { BudgetStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { ISO_MONTH_PATTERN, PaginationQueryDto, SortOrder, trimString } from '../../common';
import { MAX_MONEY_AMOUNT } from '../accounting';

/** Сколько строк плана принимается за один запрос. */
export const MAX_BUDGET_LINES = 100;

/** По чему сортируется список бюджетов. */
export enum BudgetSortField {
  /** По началу периода — по умолчанию: планы читают лентой, свежие сверху. */
  PeriodFrom = 'periodFrom',
  Name = 'name',
  CreatedAt = 'createdAt',
}

/** Строка плана: статья, сколько выделено и сколько по ней уже ушло. */
export class BudgetLineDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: { id: 'uuid', name: 'Налоги' } })
  category!: { id: string; name: string };

  @ApiPropertyOptional({
    nullable: true,
    example: null,
    description: 'Родитель статьи; `null` — статья верхнего уровня.',
  })
  categoryParent!: { id: string; name: string } | null;

  @ApiProperty({ example: 30000, description: 'Сколько выделено, в сомони.' })
  allocated!: number;

  @ApiProperty({
    example: 28400,
    description:
      'Сколько ушло за период бюджета. **Не хранится, а считается** по расходам: ' +
      'план по разделу собирает расходы всех его подкатегорий («Налоги» видят НДС).',
  })
  spent!: number;

  @ApiProperty({
    example: 1600,
    description: '`allocated − spent`. Отрицательное значение — перерасход, это законный ответ.',
  })
  remaining!: number;

  @ApiPropertyOptional({
    nullable: true,
    example: 94.67,
    description: 'Освоение плана в процентах. `null` у строки с нулевым планом — делить не на что.',
  })
  usage!: number | null;

  @ApiProperty({ example: false, description: 'Потрачено больше выделенного.' })
  overspent!: boolean;

  @ApiPropertyOptional({ nullable: true })
  note!: string | null;
}

/** Итоги плана — одни на весь бюджет. */
export class BudgetTotalsDto {
  @ApiProperty({ example: 50000 })
  allocated!: number;

  @ApiProperty({ example: 46750 })
  spent!: number;

  @ApiProperty({ example: 3250 })
  remaining!: number;

  @ApiPropertyOptional({ nullable: true, example: 93.5 })
  usage!: number | null;

  @ApiProperty({ example: false })
  overspent!: boolean;
}

/** Бюджет в списке: без строк, но с итогами — иначе список ничего не говорит. */
export class BudgetDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Бюджет на I квартал 2026' })
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiProperty({ example: '2026-01', description: 'Первый месяц периода, включительно.' })
  periodFrom!: string;

  @ApiProperty({ example: '2026-03', description: 'Последний месяц периода, включительно.' })
  periodTo!: string;

  @ApiProperty({
    enum: BudgetStatus,
    description:
      '`DRAFT` — черновик, `ACTIVE` — действует, `CLOSED` — период закрыт и план больше ' +
      'не правится (снимок принятого решения).',
  })
  status!: BudgetStatus;

  @ApiProperty({ example: 'Действует' })
  statusTitle!: string;

  @ApiProperty({ example: 3, description: 'Сколько статей запланировано.' })
  linesCount!: number;

  @ApiProperty({ type: BudgetTotalsDto })
  totals!: BudgetTotalsDto;

  @ApiPropertyOptional({
    nullable: true,
    example: { id: 'uuid', firstName: 'Аниса', lastName: 'Р.' },
  })
  createdBy!: { id: string; firstName: string; lastName: string } | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

/** Карточка бюджета: тот же бюджет вместе со строками плана. */
export class BudgetCardDto extends BudgetDto {
  @ApiProperty({ type: [BudgetLineDto] })
  lines!: BudgetLineDto[];
}

export class BudgetDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Бюджет на I квартал 2026' })
  name!: string;
}

/** Строка плана в теле запроса. */
export class BudgetLineInputDto {
  @ApiProperty({ format: 'uuid', description: 'Статья расхода из справочника категорий.' })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ example: 30000, description: 'Сколько выделено, в сомони. Ноль допустим.' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY_AMOUNT)
  allocated!: number;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class CreateBudgetDto {
  @ApiProperty({ example: 'Бюджет на I квартал 2026', minLength: 3, maxLength: 200 })
  @Transform(trimString)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ maxLength: 1000, description: 'Пустая строка очищает поле.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ example: '2026-01', description: 'Первый месяц периода, включительно.' })
  @Transform(trimString)
  @IsString()
  @Matches(ISO_MONTH_PATTERN, { message: 'periodFrom: ожидается месяц в формате YYYY-MM' })
  periodFrom!: string;

  @ApiProperty({ example: '2026-03', description: 'Последний месяц периода, включительно.' })
  @Transform(trimString)
  @IsString()
  @Matches(ISO_MONTH_PATTERN, { message: 'periodTo: ожидается месяц в формате YYYY-MM' })
  periodTo!: string;

  @ApiPropertyOptional({ enum: BudgetStatus, default: BudgetStatus.DRAFT })
  @IsOptional()
  @IsEnum(BudgetStatus)
  status?: BudgetStatus;

  @ApiPropertyOptional({
    type: [BudgetLineInputDto],
    description:
      'Строки плана. Раздел и его подкатегория в одном бюджете не соседствуют (422): ' +
      'расход по подкатегории попал бы в обе строки.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BUDGET_LINES)
  @ValidateNested({ each: true })
  @Type(() => BudgetLineInputDto)
  lines?: BudgetLineInputDto[];
}

/**
 * Правка бюджета. `lines` **заменяет набор целиком** — шестой раз то же
 * решение, что с галочками прав позиции (0006), «Show to group» (0009), днями
 * недели журнала (0018), позициями сотрудника (0020) и курсами купона (0027):
 * экран сохраняет весь план, и при слиянии снять строку было бы нечем.
 * Пустой массив снимает все строки, не переданное поле их не трогает.
 */
export class UpdateBudgetDto extends PartialType(CreateBudgetDto) {
  @ApiPropertyOptional({
    type: [BudgetLineInputDto],
    description: 'Заменяет набор строк целиком; пустой массив очищает план.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_BUDGET_LINES)
  @ValidateNested({ each: true })
  @Type(() => BudgetLineInputDto)
  override lines?: BudgetLineInputDto[];
}

/** Список бюджетов (ТЗ 5.16: `GET /accounting/budget`). */
export class BudgetsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: BudgetSortField, default: BudgetSortField.PeriodFrom })
  @IsOptional()
  @IsEnum(BudgetSortField)
  override sort: BudgetSortField = BudgetSortField.PeriodFrom;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Desc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({ enum: BudgetStatus })
  @IsOptional()
  @IsEnum(BudgetStatus)
  status?: BudgetStatus;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Только планы, в которых есть строка по этой статье.',
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    example: '2026-01',
    description: 'Планы, чей период **пересекается** с этим отрезком: месяц начала.',
  })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'from: ожидается месяц в формате YYYY-MM' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-12', description: 'Месяц конца отрезка пересечения.' })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'to: ожидается месяц в формате YYYY-MM' })
  to?: string;
}
