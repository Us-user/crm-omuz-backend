import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

import { ISO_MONTH_PATTERN } from '../../common';

/** Период обзора: оба конца — месяцы включительно. */
export class OverviewPeriodDto {
  @ApiProperty({ example: '2025-08' })
  from!: string;

  @ApiProperty({ example: '2026-07' })
  to!: string;

  @ApiProperty({ example: 12, description: 'Сколько месяцев в периоде.' })
  months!: number;
}

/**
 * Начисления периода (ТЗ 5.16: «Total payment / Paid / Not paid»).
 *
 * Это **не** касса: числа считаются по месяцам обучения, а не по дням,
 * когда деньги пришли. Неоплаченный месяц увеличивает `charged` и `debt`,
 * но не увеличивает `income`.
 */
export class OverviewChargesDto {
  @ApiProperty({ example: 96000, description: '«Total payment» — начислено с учётом скидок.' })
  charged!: number;

  @ApiProperty({ example: 67200, description: '«Paid» — принято по этим месяцам.' })
  paid!: number;

  @ApiProperty({ example: 28800, description: '«Not paid» — остаток по незакрытым месяцам.' })
  debt!: number;
}

/** Столбец графика «Income vs Expense» (ТЗ 5.16). */
export class OverviewMonthDto {
  @ApiProperty({ example: '2026-09' })
  month!: string;

  @ApiProperty({ example: 12400 })
  income!: number;

  @ApiProperty({ example: 8100, description: 'Расходы центра — **без** зарплаты.' })
  expense!: number;

  @ApiProperty({ example: 3400, description: 'Выплаченная за месяц зарплата (ТЗ 5.16).' })
  salary!: number;

  @ApiProperty({
    example: 900,
    description: '`income − expense − salary`; бывает отрицательным.',
  })
  net!: number;
}

/** Строка свода расходов по категориям. */
export class OverviewCategoryDto {
  @ApiProperty({ example: { id: 'uuid', name: 'Налоги' } })
  category!: { id: string; name: string };

  @ApiProperty({ example: 21400, description: 'Сумма вместе с подкатегориями.' })
  amount!: number;

  @ApiProperty({ example: 26.5, description: 'Доля от всех расходов периода, в процентах.' })
  share!: number;

  @ApiProperty({
    example: [{ category: { id: 'uuid', name: 'НДС' }, amount: 12000 }],
    description: 'Разбивка по подкатегориям; у листа верхнего уровня — пустой список.',
  })
  children!: { category: { id: string; name: string }; amount: number }[];
}

/** Строка «Students payment по группам» (ТЗ 5.16). */
export class OverviewGroupDto {
  @ApiProperty({ example: { id: 'uuid', name: 'Frontend-1' } })
  group!: { id: string; name: string };

  @ApiPropertyOptional({ nullable: true, example: { id: 'uuid', name: 'Frontend Basic' } })
  course!: { id: string; name: string } | null;

  @ApiPropertyOptional({ nullable: true, example: { id: 'uuid', name: 'Sadbarg' } })
  branch!: { id: string; name: string } | null;

  @ApiProperty({ example: 14, description: 'Сколько студентов получили начисления в периоде.' })
  students!: number;

  @ApiProperty({ example: 16800 })
  charged!: number;

  @ApiProperty({ example: 12600 })
  paid!: number;

  @ApiProperty({ example: 4200 })
  debt!: number;
}

/**
 * Обзор бухгалтерии (ТЗ 5.16: «Обзор: Total payment / Paid / Not paid / Net;
 * Income vs Expense; Students payment по группам»).
 *
 * Двух денежных правд здесь нет, но чисел два вида, и путать их нельзя:
 * `charges` — про **начисленное** за месяцы периода, `income` — про **принятые**
 * за период деньги (по дню платежа, вместе с предоплатами). `Net` считается
 * от кассы: центр заработал столько, сколько получил, за вычетом того,
 * что потратил (решение пользователя, сессия 0030).
 */
export class OverviewDto {
  @ApiProperty({ type: OverviewPeriodDto })
  period!: OverviewPeriodDto;

  @ApiProperty({ type: OverviewChargesDto })
  charges!: OverviewChargesDto;

  @ApiProperty({
    example: 71300,
    description: 'Принятые за период деньги, включая предоплаты, — по дню платежа.',
  })
  income!: number;

  @ApiProperty({
    example: 52800,
    description: 'Расходы периода по дню платежа — **без зарплаты**, она стоит отдельно.',
  })
  expense!: number;

  @ApiProperty({
    example: 34200,
    description:
      'Выплаченная за период зарплата (ТЗ 5.16), по дню выплаты. Отдельным числом, а не ' +
      'статьёй расходов: выплата не заводит `Expense` — деньги уже записаны выплатой, ' +
      'и вторая копия того же числа расходилась бы с первой при каждой отмене (решение 0032).',
  })
  salary!: number;

  @ApiProperty({ example: -15700, description: '«Net» = `income − expense − salary`.' })
  net!: number;

  @ApiProperty({
    type: [OverviewMonthDto],
    description: 'График «Income vs Expense» по месяцам; зарплата — третий столбец.',
  })
  byMonth!: OverviewMonthDto[];

  @ApiProperty({
    type: [OverviewCategoryDto],
    description:
      'Расходы по корневым категориям. Зарплаты здесь нет: она не статья расхода, ' +
      'и её сумма стоит отдельным полем `salary`.',
  })
  byCategory!: OverviewCategoryDto[];

  @ApiProperty({ type: [OverviewGroupDto], description: '«Students payment по группам».' })
  byGroup!: OverviewGroupDto[];
}

/**
 * Период обзора. Филиала здесь нет намеренно: приход не всегда привязан
 * к филиалу (предоплата заведена на студента, а не на группу), и фильтр
 * молча выкидывал бы её из `income` — обзор разошёлся бы с кассой, ничего
 * об этом не сказав. Разрез по филиалам даёт список расходов и строка
 * группы в `byGroup`.
 */
export class OverviewQueryDto {
  @ApiPropertyOptional({
    example: '2026-01',
    description: 'Начало периода, месяц включительно. По умолчанию — 12 месяцев по `to`.',
  })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'from: ожидается месяц в формате YYYY-MM' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-06',
    description: 'Конец периода, месяц включительно. По умолчанию — текущий месяц.',
  })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'to: ожидается месяц в формате YYYY-MM' })
  to?: string;
}
