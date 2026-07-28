import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StudentStatus } from '@prisma/client';
import { IsOptional, IsUUID, Matches } from 'class-validator';

import { ISO_MONTH_PATTERN, PaginationQueryDto } from '../../common';

/** Должник (ТЗ 5.16: «Debtors»). */
export class DebtorDto {
  @ApiProperty({
    example: { id: 'uuid', firstName: 'Нилуфар', lastName: 'Каримова', phone: '+992901234567' },
  })
  student!: {
    id: string;
    firstName: string;
    lastName: string;
    phone: string;
    status: StudentStatus;
  };

  @ApiPropertyOptional({ nullable: true, example: { id: 'uuid', name: 'Sadbarg' } })
  branch!: { id: string; name: string } | null;

  @ApiProperty({ example: 3600, description: 'Начислено за период с учётом скидок.' })
  charged!: number;

  @ApiProperty({ example: 1200, description: 'Принято по месяцам этого периода.' })
  paid!: number;

  @ApiProperty({ example: 2400, description: 'Долг — сумма остатков по незакрытым месяцам.' })
  debt!: number;

  @ApiProperty({
    example: 500,
    description:
      'Принятые вперёд деньги, ещё не разнесённые по месяцам (ТЗ 5.16: Prepayment). ' +
      'Долг они **не гасят**: месяц закрывается разнесением платежа, а не наличием денег ' +
      'на счету — бухгалтер должен видеть оба числа.',
  })
  prepaid!: number;

  @ApiProperty({ example: 2, description: 'Сколько месяцев остались незакрытыми.' })
  unpaidMonths!: number;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-08',
    description: 'Самый ранний незакрытый месяц — с него начинается разговор о долге.',
  })
  oldestUnpaidMonth!: string | null;
}

/** Итоги витрины должников — одни на все страницы, уходят в `meta`. */
export class DebtorsTotalsDto {
  @ApiProperty({ example: 12, description: 'Сколько студентов должны центру.' })
  students!: number;

  @ApiProperty({ example: 28800, description: 'Общий долг по отобранному набору.' })
  debt!: number;

  @ApiProperty({ example: 96000, description: 'Начислено этим студентам за период.' })
  charged!: number;

  @ApiProperty({ example: 67200, description: 'Ими же оплачено за период.' })
  paid!: number;
}

/** Витрина должников (ТЗ 5.16). */
export class DebtorsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
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

  @ApiPropertyOptional({ example: '2026-01', description: 'Начало периода, месяц включительно.' })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'from: ожидается месяц в формате YYYY-MM' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-06', description: 'Конец периода, месяц включительно.' })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'to: ожидается месяц в формате YYYY-MM' })
  to?: string;
}
