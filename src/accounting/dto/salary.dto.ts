import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SalaryStatus } from '@prisma/client';
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

/** По чему сортируется ведомость зарплат. */
export enum SalarySortField {
  /**
   * По фамилии сотрудника — по умолчанию: ведомость месяца читают списком
   * людей, а не рейтингом сумм.
   */
  Employee = 'employee',
  Total = 'total',
  CreatedAt = 'createdAt',
}

/** Сотрудник в строке ведомости. */
export class SalaryEmployeeDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Фаррух' })
  firstName!: string;

  @ApiProperty({ example: 'Раҳимов' })
  lastName!: string;

  @ApiProperty({ example: '+992901234567' })
  phone!: string;

  @ApiPropertyOptional({ nullable: true, example: { id: 'uuid', name: 'Sadbarg' } })
  branch!: { id: string; name: string } | null;
}

/** Ступень ментора, по которой считалась ставка месяца (ТЗ 5.14, 5.16). */
export class SalaryLevelDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Senior mentor' })
  name!: string;
}

/** Расчёт зарплаты за месяц (ТЗ 5.16: «Total/Prepaid/Remaining/Paid»). */
export class SalaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: SalaryEmployeeDto })
  employee!: SalaryEmployeeDto;

  @ApiProperty({ example: '2026-09', description: 'Месяц зарплаты.' })
  month!: string;

  @ApiProperty({ enum: SalaryStatus })
  status!: SalaryStatus;

  @ApiProperty({ example: 'Черновик' })
  statusTitle!: string;

  @ApiProperty({
    example: 42.5,
    description:
      'Часы фактически проведённых занятий за месяц (ТЗ 5.16) — из журнала группы, ' +
      'а не из расписания. У подтверждённого расчёта — из снимка.',
  })
  hours!: number;

  @ApiPropertyOptional({
    nullable: true,
    type: SalaryLevelDto,
    description: 'Ступень месяца; `null` — уровень на этот месяц не проставлен.',
  })
  level!: SalaryLevelDto | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 27,
    description:
      'Часовая ставка уровня месяца в сомони. `null` — уровня в месяце нет, и часы ' +
      'в деньги не превращаются: пробел виден, а не заполнен нулём (правило 0021).',
  })
  hourlyRate!: number | null;

  @ApiProperty({ example: 1147.5, description: 'Заработано часами, без премии.' })
  earned!: number;

  @ApiProperty({ example: 200, description: '«Bonus» из ТЗ 5.16.' })
  bonus!: number;

  @ApiProperty({ example: 1347.5, description: '«Total» = заработано + премия.' })
  total!: number;

  @ApiProperty({
    example: 400,
    description: '«Prepaid» — одобренные заявки на аванс за этот месяц (ТЗ 5.16).',
  })
  prepaid!: number;

  @ApiProperty({ example: 500, description: '«Paid» — уже выплачено по этому расчёту.' })
  paid!: number;

  @ApiProperty({
    example: 447.5,
    description:
      '«Remaining» = `Total − Prepaid − Paid`. **Бывает отрицательным**: аванс может ' +
      'оказаться больше заработанного, и ноль вместо минуса утверждал бы, что центр в расчёте.',
  })
  remaining!: number;

  @ApiPropertyOptional({ nullable: true })
  note!: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  confirmedAt!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: { id: 'uuid', firstName: 'Аниса', lastName: 'Р.' },
  })
  confirmedBy!: { id: string; firstName: string; lastName: string } | null;

  @ApiPropertyOptional({
    nullable: true,
    example: { id: 'uuid', firstName: 'Аниса', lastName: 'Р.' },
  })
  createdBy!: { id: string; firstName: string; lastName: string } | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

/** Выплата по расчёту (ТЗ 5.16: «Paid»). */
export class SalaryTransactionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 500, description: 'Сумма выплаты в сомони.' })
  amount!: number;

  @ApiProperty({ example: '2026-10-05', description: 'День, когда деньги ушли.' })
  paidAt!: string;

  @ApiProperty({ example: { id: 'uuid', name: 'Наличные' } })
  type!: { id: string; name: string };

  @ApiPropertyOptional({ nullable: true })
  comment!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: { id: 'uuid', firstName: 'Аниса', lastName: 'Р.' },
  })
  createdBy!: { id: string; firstName: string; lastName: string } | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

/**
 * Дневная строка расчёта (ТЗ 5.16: «Daily salaries (Default/Detail)»).
 *
 * Своей таблицы у неё нет: `DailySalary` из карты сущностей ТЗ 4 был бы копией
 * журнала. Это учебный день, который сотрудник **фактически провёл**, и его
 * длительность, умноженная на ставку месяца.
 */
export class SalaryDayDto {
  @ApiProperty({ example: '2026-09-07' })
  date!: string;

  @ApiPropertyOptional({
    nullable: true,
    example: { id: 'uuid', name: 'Frontend-1' },
    description: 'Группа, в которой прошло занятие.',
  })
  group!: { id: string; name: string } | null;

  @ApiProperty({ example: 90, description: 'Длительность занятия в минутах.' })
  minutes!: number;

  @ApiProperty({ example: 1.5 })
  hours!: number;

  @ApiProperty({ example: 40.5, description: 'Часы × ставка месяца, в сомони.' })
  amount!: number;
}

/** Карточка расчёта: та же строка плюс дневная раскладка и выплаты. */
export class SalaryCardDto extends SalaryDto {
  @ApiProperty({
    type: [SalaryDayDto],
    description:
      'Дневная раскладка (ТЗ 5.16: «Daily salaries»). У **подтверждённого** расчёта дни ' +
      'по-прежнему читаются из журнала, а суммы считаются по ставке снимка: сам итог ' +
      'заморожен, а раскладка — витрина. Если журнал правили после подтверждения, ' +
      'сумма дней разойдётся с `earned`, и это видно.',
  })
  days!: SalaryDayDto[];

  @ApiProperty({ type: [SalaryTransactionDto] })
  transactions!: SalaryTransactionDto[];
}

/** Итоги ведомости — одни на все страницы, уходят в `meta.totals`. */
export class SalaryTotalsDto {
  @ApiProperty({ example: 14, description: 'Сколько расчётов в отобранном наборе.' })
  count!: number;

  @ApiProperty({ example: 9, description: 'Сколько из них подтверждено (ТЗ 5.16: «Done»).' })
  confirmed!: number;

  @ApiProperty({ example: 512.5 })
  hours!: number;

  @ApiProperty({ example: 43800 })
  total!: number;

  @ApiProperty({ example: 6200 })
  prepaid!: number;

  @ApiProperty({ example: 21000 })
  paid!: number;

  @ApiProperty({ example: 16600 })
  remaining!: number;
}

/** Результат «сформировать ведомость месяца». */
export class SalarySheetCreatedDto {
  @ApiProperty({ example: '2026-09' })
  month!: string;

  @ApiProperty({ example: 12, description: 'Сколько расчётов заведено.' })
  created!: number;

  @ApiProperty({
    example: 3,
    description: 'Сколько пропущено: расчёт на этого сотрудника в этом месяце уже был.',
  })
  skipped!: number;

  @ApiProperty({ type: [SalaryDto], description: 'Ведомость месяца целиком после запуска.' })
  salaries!: SalaryDto[];
}

export class SalaryDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Раҳимов Фаррух, 2026-09' })
  title!: string;
}

export class SalaryTransactionDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '500 TJS от 2026-10-05' })
  title!: string;
}

/**
 * «Сформировать ведомость месяца» — осознанное действие, а не фоновая задача
 * (тот же ход, что с начислением студентам, 0029, и закрытием месяца рейтинга,
 * 0024): работающих задач в проекте нет до Фазы 11.
 *
 * Идемпотентно по паре «сотрудник + месяц»: повторный запуск второй строки
 * не заводит, а досоздаёт недостающие.
 */
export class CreateSalarySheetDto {
  @ApiProperty({ example: '2026-09', description: 'Месяц зарплаты, `YYYY-MM`.' })
  @Matches(ISO_MONTH_PATTERN, { message: 'month: ожидается месяц в формате YYYY-MM' })
  month!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Один сотрудник вместо всех. Без него ведомость заводится каждому, у кого в этом ' +
      'месяце есть проведённые занятия или одобренный аванс.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

/**
 * Правка расчёта: премия и примечание. Часы и ставку править нельзя — они
 * приходят из журнала и справочника, и вводить их руками значило бы завести
 * второй источник истины о том же (разбор 0032).
 */
export class UpdateSalaryDto {
  @ApiPropertyOptional({ example: 200, description: '«Bonus» из ТЗ 5.16, в сомони.' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY_AMOUNT)
  bonus?: number;

  @ApiPropertyOptional({ maxLength: 1000, description: 'Пустая строка очищает поле.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** Выплата по расчёту (ТЗ 5.16: `POST /accounting/salary/{id}/pay`). */
export class PaySalaryDto {
  @ApiProperty({
    example: 500,
    description:
      'Сумма в сомони. Не может превышать остаток (`Remaining`) — то же правило, ' +
      'что у платежа студента (0029): переплата зарплаты вернуться уже не может.',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_MONEY_AMOUNT)
  amount!: number;

  @ApiProperty({ format: 'uuid', description: 'Способ выплаты из справочника (Cash/Alif).' })
  @IsUUID()
  typeId!: string;

  @ApiPropertyOptional({
    example: '2026-10-05',
    description: 'День выплаты. По умолчанию — сегодня.',
  })
  @IsOptional()
  @Matches(ISO_DATE_PATTERN, { message: 'paidAt должна быть датой в формате YYYY-MM-DD' })
  paidAt?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  comment?: string;
}

/** Причина отмены выплаты — как при отмене платежа студента (0029). */
export class SalaryReasonDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    example: 'Выплата проведена дважды по ошибке кассира',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

/**
 * Ведомость зарплат (ТЗ 5.16: `GET /accounting/salary`).
 *
 * Период здесь — **один месяц**, а не отрезок: зарплату считают помесячно
 * (ставка уровня и аванс привязаны к месяцу), и отрезок сложил бы в одну строку
 * два разных расчёта. Без `month` берётся текущий месяц.
 */
export class SalaryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SalarySortField, default: SalarySortField.Employee })
  @IsOptional()
  @IsEnum(SalarySortField)
  override sort: SalarySortField = SalarySortField.Employee;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({
    example: '2026-09',
    description: 'Месяц зарплаты. По умолчанию — текущий.',
  })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'month: ожидается месяц в формате YYYY-MM' })
  month?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Филиал сотрудника (ТЗ 3.3).' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ enum: SalaryStatus })
  @IsOptional()
  @IsEnum(SalaryStatus)
  status?: SalaryStatus;
}
