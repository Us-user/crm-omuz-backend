import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
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
  ValidateIf,
} from 'class-validator';

import {
  ISO_DATE_PATTERN,
  ISO_MONTH_PATTERN,
  PaginationQueryDto,
  SortOrder,
  trimString,
} from '../../common';
import { MAX_MONEY_AMOUNT } from '../accounting';

/** По чему сортируется история платежей. */
export enum TransactionSortField {
  /** День получения денег — по умолчанию, свежие сверху. */
  PaidAt = 'paidAt',
  Amount = 'amount',
  Name = 'name',
}

/** Полученные деньги (ТЗ 5.16). */
export class PaymentTransactionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    example: { id: 'uuid', firstName: 'Нилуфар', lastName: 'Каримова', phone: '+992901234567' },
  })
  student!: { id: string; firstName: string; lastName: string; phone: string };

  @ApiPropertyOptional({
    nullable: true,
    example: { id: 'uuid', month: '2026-09', group: { id: 'uuid', name: 'Frontend-1' } },
    description:
      'Месяц, который закрывает платёж. `null` — **предоплата**: деньги приняты, но ' +
      'по месяцам не разнесены (ТЗ 5.16: «Prepayment для текущего/нового студента»).',
  })
  charge!: { id: string; month: string; group: { id: string; name: string } } | null;

  @ApiProperty({ example: false, description: 'Предоплата ли это — то же, что `charge === null`.' })
  prepayment!: boolean;

  @ApiProperty({ example: 600 })
  amount!: number;

  @ApiProperty({ example: '2026-09-05', description: 'День получения денег.' })
  paidAt!: string;

  @ApiPropertyOptional({ nullable: true, example: { id: 'uuid', name: 'Alif' } })
  type!: { id: string; name: string } | null;

  @ApiPropertyOptional({ nullable: true })
  comment!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Последняя правка «с причиной» (ТЗ 5.16). `null` — платёж не правили. Полная история ' +
      'правок — это `AuditLog` Фазы 13, а не вторая строка о том же платеже.',
  })
  edit!: {
    reason: string;
    at: string;
    by: { id: string; firstName: string; lastName: string } | null;
  } | null;

  @ApiPropertyOptional({ nullable: true })
  createdBy!: { id: string; firstName: string; lastName: string } | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class PaymentDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Каримова Нилуфар, 600 TJS от 2026-09-05' })
  title!: string;
}

/** Приём оплаты по начислению (ТЗ 5.16). */
export class CreatePaymentDto {
  @ApiProperty({ format: 'uuid', description: 'Месяц, который закрывает платёж.' })
  @IsUUID()
  chargeId!: string;

  @ApiProperty({
    example: 600,
    description:
      'Полученная сумма в сомони. Не больше остатка месяца: переплата — это предоплата, ' +
      'а не «месяц, оплаченный дважды» (422).',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_MONEY_AMOUNT)
  amount!: number;

  @ApiPropertyOptional({
    example: '2026-09-05',
    description: 'День получения денег. По умолчанию — сегодня.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(ISO_DATE_PATTERN, { message: 'paidAt должна быть датой в формате YYYY-MM-DD' })
  paidAt?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Способ оплаты из справочника (ТЗ 5.16).' })
  @IsOptional()
  @IsUUID()
  typeId?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  comment?: string;
}

/** Предоплата: деньги приняты до того, как месяц начислен (ТЗ 5.16). */
export class CreatePrepaymentDto {
  @ApiProperty({ format: 'uuid', description: 'Кому приняты деньги.' })
  @IsUUID()
  studentId!: string;

  @ApiProperty({ example: 1200, description: 'Полученная сумма в сомони.' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_MONEY_AMOUNT)
  amount!: number;

  @ApiPropertyOptional({ example: '2026-08-28', description: 'День получения денег.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(ISO_DATE_PATTERN, { message: 'paidAt должна быть датой в формате YYYY-MM-DD' })
  paidAt?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  typeId?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  comment?: string;
}

/**
 * Правка платежа — **с обязательной причиной** (ТЗ 5.16).
 *
 * Ею же предоплата разносится по месяцу: `chargeId` со значением привязывает
 * платёж к месяцу, пустая строка возвращает его в предоплату. `@ValidateIf`
 * вместо `@IsUUID()` — иначе пустая строка не прошла бы валидацию, и снять
 * привязку было бы нечем (та же ловушка, что с `roomId` слота в 0011).
 */
export class UpdatePaymentDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    example: 'Оператор ошибся суммой: в чеке 600, а не 6000',
    description: 'Причина правки. Хранится последняя — полная история это `AuditLog` Фазы 13.',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({ example: 600 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_MONEY_AMOUNT)
  amount?: number;

  @ApiPropertyOptional({ example: '2026-09-05' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(ISO_DATE_PATTERN, { message: 'paidAt должна быть датой в формате YYYY-MM-DD' })
  paidAt?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Пустая строка снимает способ оплаты.' })
  @IsOptional()
  @Transform(trimString)
  @ValidateIf((_, value) => value !== '')
  @IsUUID()
  typeId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Месяц, который закрывает платёж. Пустая строка снимает привязку и возвращает ' +
      'деньги в предоплату.',
  })
  @IsOptional()
  @Transform(trimString)
  @ValidateIf((_, value) => value !== '')
  @IsUUID()
  chargeId?: string;

  @ApiPropertyOptional({ maxLength: 500, description: 'Пустая строка очищает комментарий.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  comment?: string;
}

/** Тот же разбор булева параметра, что у `hasAccount` в списке студентов (0014). */
const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/** История платежей (ТЗ 5.16). */
export class TransactionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: TransactionSortField, default: TransactionSortField.PaidAt })
  @IsOptional()
  @IsEnum(TransactionSortField)
  override sort: TransactionSortField = TransactionSortField.PaidAt;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Desc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  studentId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Платежи по одному месяцу.' })
  @IsOptional()
  @IsUUID()
  chargeId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Способ оплаты.' })
  @IsOptional()
  @IsUUID()
  typeId?: string;

  @ApiPropertyOptional({
    description: '`true` — только предоплаты, `false` — только разнесённые по месяцам.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  prepayment?: boolean;

  @ApiPropertyOptional({
    example: '2026-09',
    description: 'Начало периода **получения денег**, месяц включительно.',
  })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'from: ожидается месяц в формате YYYY-MM' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-09', description: 'Конец периода, месяц включительно.' })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'to: ожидается месяц в формате YYYY-MM' })
  to?: string;
}
