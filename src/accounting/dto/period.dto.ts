import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { AccountingPeriodStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { ISO_MONTH_PATTERN, PaginationQueryDto, SortOrder, trimString } from '../../common';

/** По чему сортируется список периодов. */
export enum AccountingPeriodSortField {
  /** По началу периода — по умолчанию: отчёты читают лентой, свежие сверху. */
  PeriodFrom = 'periodFrom',
  Name = 'name',
  CreatedAt = 'createdAt',
}

/**
 * Отчёт периода (ТЗ 5.16: income/expense/paid/notpaid/net).
 *
 * У периода **в работе** числа считаются агрегатами при каждом чтении,
 * у **закрытого** — берутся из снимка. `debt` и `net` не хранятся ни у того,
 * ни у другого: они выводятся из первичных чисел одной и той же функцией.
 */
export class PeriodReportDto {
  @ApiProperty({
    example: 148000,
    description: '«Total payment»: начислено за месяцы обучения периода, с учётом скидок.',
  })
  charged!: number;

  @ApiProperty({ example: 121500, description: '«Paid»: принято по этим месяцам.' })
  paid!: number;

  @ApiProperty({ example: 26500, description: '«Not paid»: остаток по месяцам обучения.' })
  debt!: number;

  @ApiProperty({
    example: 130200,
    description:
      'Принятые за период деньги **по дню платежа**, вместе с предоплатами — это касса, ' +
      'а не план: она не совпадает с `paid` и не должна.',
  })
  income!: number;

  @ApiProperty({ example: 42800, description: 'Расходы центра — без зарплаты (она ниже).' })
  expense!: number;

  @ApiProperty({
    example: 61000,
    description:
      'Выплаченная за период зарплата, по дню выплаты. Отдельным числом, а не внутри ' +
      '`expense`: выплата не заводит `Expense` (решение 0032).',
  })
  salary!: number;

  @ApiProperty({
    example: 26400,
    description: '`income − expense − salary`. Отрицательный — законный ответ.',
  })
  net!: number;
}

/** Финансовый период в списке и в карточке. */
export class AccountingPeriodDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'III квартал 2026' })
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiProperty({ example: '2026-07', description: 'Первый месяц периода, включительно.' })
  periodFrom!: string;

  @ApiProperty({ example: '2026-09', description: 'Последний месяц периода, включительно.' })
  periodTo!: string;

  @ApiProperty({ example: 3, description: 'Сколько месяцев в периоде.' })
  months!: number;

  @ApiProperty({
    enum: AccountingPeriodStatus,
    description:
      '`IN_PROGRESS` — «Inprogress» из ТЗ: период ведётся, числа живые. ' +
      '`ARCHIVED` — «Archive»: числа заморожены снимком, а операции, датированные ' +
      'внутри периода, больше не принимаются.',
  })
  status!: AccountingPeriodStatus;

  @ApiProperty({ example: 'В работе' })
  statusTitle!: string;

  @ApiProperty({
    type: PeriodReportDto,
    description: 'У закрытого периода — из снимка, у периода в работе — посчитанный на лету.',
  })
  report!: PeriodReportDto;

  @ApiProperty({
    example: false,
    description:
      'Взяты ли числа из снимка. У закрытого периода — `true`; отсюда прямое следствие: ' +
      'правка кассы задним числом их больше не двигает.',
  })
  frozen!: boolean;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  closedAt!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: { id: 'uuid', firstName: 'Аниса', lastName: 'Р.' },
  })
  closedBy!: { id: string; firstName: string; lastName: string } | null;

  @ApiPropertyOptional({
    nullable: true,
    example: { id: 'uuid', firstName: 'Аниса', lastName: 'Р.' },
  })
  createdBy!: { id: string; firstName: string; lastName: string } | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AccountingPeriodDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'III квартал 2026' })
  name!: string;
}

export class CreateAccountingPeriodDto {
  @ApiProperty({ example: 'III квартал 2026', minLength: 3, maxLength: 200 })
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

  @ApiProperty({ example: '2026-07', description: 'Первый месяц периода, включительно.' })
  @Transform(trimString)
  @IsString()
  @Matches(ISO_MONTH_PATTERN, { message: 'periodFrom: ожидается месяц в формате YYYY-MM' })
  periodFrom!: string;

  @ApiProperty({ example: '2026-09', description: 'Последний месяц периода, включительно.' })
  @Transform(trimString)
  @IsString()
  @Matches(ISO_MONTH_PATTERN, { message: 'periodTo: ожидается месяц в формате YYYY-MM' })
  periodTo!: string;
}

/**
 * Правка периода. Статуса здесь нет намеренно: закрытие — отдельное действие
 * со своим снимком и своим маршрутом (`POST …/close` из ТЗ 5.16), и менять
 * его «заодно» с названием значило бы снимать отчёт молча.
 */
export class UpdateAccountingPeriodDto extends PartialType(CreateAccountingPeriodDto) {}

/** Список периодов (ТЗ 5.16: `GET /accounting/periods`). */
export class AccountingPeriodsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: AccountingPeriodSortField,
    default: AccountingPeriodSortField.PeriodFrom,
  })
  @IsOptional()
  @IsEnum(AccountingPeriodSortField)
  override sort: AccountingPeriodSortField = AccountingPeriodSortField.PeriodFrom;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Desc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({ enum: AccountingPeriodStatus })
  @IsOptional()
  @IsEnum(AccountingPeriodStatus)
  status?: AccountingPeriodStatus;

  @ApiPropertyOptional({
    example: '2026-01',
    description: 'Периоды, **пересекающиеся** с этим отрезком: месяц начала.',
  })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'from: ожидается месяц в формате YYYY-MM' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-12', description: 'Месяц конца отрезка пересечения.' })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'to: ожидается месяц в формате YYYY-MM' })
  to?: string;
}
