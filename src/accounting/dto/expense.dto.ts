import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
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
} from 'class-validator';

import {
  ISO_DATE_PATTERN,
  ISO_MONTH_PATTERN,
  PaginationQueryDto,
  SortOrder,
  trimString,
} from '../../common';
import { MAX_MONEY_AMOUNT } from '../accounting';

/** По чему сортируется список расходов. */
export enum ExpenseSortField {
  /** По дню платежа — по умолчанию: расходы читают лентой, свежие сверху. */
  SpentAt = 'spentAt',
  Amount = 'amount',
  CreatedAt = 'createdAt',
}

/** Расход центра (ТЗ 5.16: «Expenses»). */
export class ExpenseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: { id: 'uuid', name: 'НДС' } })
  category!: { id: string; name: string };

  @ApiPropertyOptional({
    nullable: true,
    example: { id: 'uuid', name: 'Налоги' },
    description: 'Родитель категории — по нему расход попадает в раздел свода.',
  })
  categoryParent!: { id: string; name: string } | null;

  @ApiProperty({ example: 'Аренда офиса за сентябрь' })
  title!: string;

  @ApiProperty({ example: 4500, description: 'Сумма в сомони.' })
  amount!: number;

  @ApiProperty({ example: '2026-09-05', description: 'День, когда деньги ушли.' })
  spentAt!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: { id: 'uuid', name: 'Sadbarg' },
    description: 'Филиал, на который отнесён расход. `null` — расход общий для центра.',
  })
  branch!: { id: string; name: string } | null;

  @ApiPropertyOptional({ nullable: true })
  note!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: { id: 'uuid', firstName: 'Аниса', lastName: 'Р.' },
  })
  createdBy!: { id: string; firstName: string; lastName: string } | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

/** Итоги списка расходов — одни на все страницы, уходят в `meta`. */
export class ExpensesTotalsDto {
  @ApiProperty({ example: 128400, description: 'Сумма расходов по всему отобранному набору.' })
  amount!: number;
}

export class ExpenseDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Аренда офиса за сентябрь, 4500 TJS от 2026-09-05' })
  title!: string;
}

export class CreateExpenseDto {
  @ApiProperty({ format: 'uuid', description: 'Статья расхода из справочника категорий.' })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ example: 'Аренда офиса за сентябрь', minLength: 3, maxLength: 300 })
  @Transform(trimString)
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  title!: string;

  @ApiProperty({ example: 4500, description: 'Сумма в сомони, больше нуля.' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_MONEY_AMOUNT)
  amount!: number;

  @ApiPropertyOptional({
    example: '2026-09-05',
    description: 'День платежа. По умолчанию — сегодня.',
  })
  @IsOptional()
  @Matches(ISO_DATE_PATTERN, { message: 'spentAt должна быть датой в формате YYYY-MM-DD' })
  spentAt?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Филиал, на который отнесён расход. Без него расход считается общим.',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ maxLength: 1000, description: 'Пустая строка очищает поле.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/**
 * Правка расхода. `branchId` пустой строкой снимает привязку к филиалу —
 * то же правило пустой строки, что у аудитории слота (0011) и разнесения
 * предоплаты (0029).
 */
export class UpdateExpenseDto extends PartialType(CreateExpenseDto) {
  @ApiPropertyOptional({ description: 'Пустая строка делает расход общим для центра.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  override branchId?: string;
}

/** Список расходов (ТЗ 5.16: `GET /accounting/expenses`). */
export class ExpensesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ExpenseSortField, default: ExpenseSortField.SpentAt })
  @IsOptional()
  @IsEnum(ExpenseSortField)
  override sort: ExpenseSortField = ExpenseSortField.SpentAt;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Desc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Статья расхода. Категория верхнего уровня отбирает **и свои подкатегории**: ' +
      '«Налоги» показывают НДС и подоходный, иначе раздел свода нечем было бы раскрыть.',
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ example: '2026-01', description: 'Начало периода, месяц включительно.' })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'from: ожидается месяц в формате YYYY-MM' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-06', description: 'Конец периода, месяц включительно.' })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'to: ожидается месяц в формате YYYY-MM' })
  to?: string;
}
