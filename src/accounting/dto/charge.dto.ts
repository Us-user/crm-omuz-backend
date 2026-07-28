import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

import { ISO_MONTH_PATTERN, PaginationQueryDto, SortOrder, trimString } from '../../common';
import { ChargeStatus, MAX_MONEY_AMOUNT } from '../accounting';
import { PaymentTransactionDto } from './transaction.dto';

/** По чему сортируется список начислений. */
export enum ChargeSortField {
  /** Месяц начисления — по умолчанию, свежие сверху. */
  Month = 'month',
  /** «Фамилия, имя» — как во всех списках людей в проекте. */
  Name = 'name',
  /** Сумма начисления. */
  Amount = 'amount',
  /** Остаток к оплате: кто должен больше всех. */
  Debt = 'debt',
}

/** Начисление за месяц обучения (ТЗ 5.16). */
export class StudentPaymentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    example: { id: 'uuid', firstName: 'Нилуфар', lastName: 'Каримова', phone: '+992901234567' },
  })
  student!: { id: string; firstName: string; lastName: string; phone: string };

  @ApiProperty({ example: { id: 'uuid', name: 'Frontend-1' } })
  group!: { id: string; name: string };

  @ApiProperty({ example: { id: 'uuid', name: 'Frontend-разработка' } })
  course!: { id: string; name: string };

  @ApiPropertyOptional({ nullable: true, example: { id: 'uuid', name: 'Sadbarg' } })
  branch!: { id: string; name: string } | null;

  @ApiProperty({ example: '2026-09', description: 'Месяц обучения, за который начислено.' })
  month!: string;

  @ApiProperty({
    example: 1200,
    description:
      'Начислено — **снимок** Fee курса на момент начисления (ТЗ 5.16). Правка стоимости ' +
      'в каталоге прошлые месяцы не переписывает.',
  })
  amount!: number;

  @ApiProperty({ example: 200, description: 'Скидка на месяц в сомони (ТЗ 5.16).' })
  discount!: number;

  @ApiPropertyOptional({ nullable: true, example: 'Скидка за второго ребёнка в семье' })
  discountReason!: string | null;

  @ApiProperty({ example: 1000, description: 'К оплате: начислено минус скидка.' })
  due!: number;

  @ApiProperty({ example: 400, description: 'Принято по этому месяцу.' })
  paid!: number;

  @ApiProperty({ example: 600, description: 'Остаток — «Not paid» из ТЗ 5.16.' })
  remaining!: number;

  @ApiProperty({
    enum: ChargeStatus,
    description: 'Статус месяца. Выводится из сумм, а не хранится отдельным полем.',
  })
  status!: ChargeStatus;

  @ApiProperty({ example: 'Оплачен частично' })
  statusTitle!: string;

  @ApiPropertyOptional({ nullable: true })
  note!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: { id: 'uuid', firstName: 'Фаррух', lastName: 'Раҳимов' },
  })
  createdBy!: { id: string; firstName: string; lastName: string } | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

/** Карточка месяца: начисление вместе с платежами, которые его закрывают. */
export class StudentPaymentCardDto extends StudentPaymentDto {
  @ApiProperty({ type: [PaymentTransactionDto], description: 'Платежи по этому месяцу.' })
  transactions!: PaymentTransactionDto[];
}

/** Итоги набора начислений (ТЗ 5.16: «Total payment / Paid / Not paid»). */
export class PaymentTotalsDto {
  @ApiProperty({ example: 24000, description: 'Начислено с учётом скидок — «Total payment».' })
  charged!: number;

  @ApiProperty({ example: 18000, description: 'Принято денег по этим месяцам — «Paid».' })
  paid!: number;

  @ApiProperty({ example: 6000, description: 'Остаток — «Not paid».' })
  debt!: number;
}

/** Результат начисления месяца. */
export class ChargeRunResultDto {
  @ApiProperty({ example: '2026-09' })
  month!: string;

  @ApiProperty({ example: 24, description: 'Сколько начислений заведено.' })
  created!: number;

  @ApiProperty({
    example: 3,
    description:
      'Сколько пропущено, потому что месяц этим студентам уже начислен. Повторный запуск ' +
      'ничего не портит: ключ «студент + группа + месяц» уникален.',
  })
  skipped!: number;

  @ApiProperty({
    type: [StudentPaymentDto],
    description: 'Начисления месяца по отобранным группам.',
  })
  charges!: StudentPaymentDto[];
}

export class ChargeDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Каримова Нилуфар, Frontend-1, 2026-09' })
  title!: string;
}

/** Начислить месяц (ТЗ 5.16: «помесячное начисление = Fee курса»). */
export class ChargeMonthDto {
  @ApiProperty({ example: '2026-09', description: 'Месяц обучения `YYYY-MM`.' })
  @Transform(trimString)
  @IsString()
  @Matches(ISO_MONTH_PATTERN, { message: 'month: ожидается месяц в формате YYYY-MM' })
  month!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Начислить только этой группе. Без него месяц начисляется **всем** группам центра, ' +
      'кроме отменённых, — по действующему составу каждой.',
  })
  @IsOptional()
  @IsUUID()
  groupId?: string;
}

/** Правка начисления: скидка с причиной и примечание (ТЗ 5.16). */
export class UpdateChargeDto {
  @ApiPropertyOptional({
    example: 200,
    description:
      'Скидка на месяц в сомони. Не больше начисленной суммы и не ниже уже принятых денег: ' +
      'иначе месяц оказался бы переплаченным, а вернуть переплату нечем.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY_AMOUNT)
  discount?: number;

  @ApiPropertyOptional({
    minLength: 3,
    maxLength: 500,
    description: 'Почему дана скидка. Обязательна при ненулевой скидке. Пустая строка очищает.',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  discountReason?: string;

  @ApiPropertyOptional({ maxLength: 1000, description: 'Примечание. Пустая строка очищает.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** Список начислений — экран «Payment's» (ТЗ 5.16). */
export class ChargesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ChargeSortField, default: ChargeSortField.Month })
  @IsOptional()
  @IsEnum(ChargeSortField)
  override sort: ChargeSortField = ChargeSortField.Month;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Desc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  studentId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: '«Students payment по группам» из ТЗ 5.16.' })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Филиал **группы** (ТЗ 3.3).' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    enum: ChargeStatus,
    description:
      '`NOT_PAID` — неоплаченные месяцы из ТЗ 5.16, `PARTIAL` — начатые, `PAID` — закрытые.',
  })
  @IsOptional()
  @IsEnum(ChargeStatus)
  status?: ChargeStatus;

  @ApiPropertyOptional({ example: '2026-01', description: 'Начало периода, месяц включительно.' })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'from: ожидается месяц в формате YYYY-MM' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-06', description: 'Конец периода, месяц включительно.' })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'to: ожидается месяц в формате YYYY-MM' })
  to?: string;
}

/** Причина отмены платежа или удаления начисления (ТЗ 5.16: правка с причиной). */
export class ReasonDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    example: 'Ошибочно заведено: студент отчислен до начала месяца',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
