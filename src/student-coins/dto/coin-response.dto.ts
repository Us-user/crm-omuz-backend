import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CoinSource } from '@prisma/client';

/** Кто начислил коины: `null` у автоначисления и у удалённого профиля. */
export class CoinAuthorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Фаррух' })
  firstName!: string;

  @ApiProperty({ example: 'Раҳимов' })
  lastName!: string;
}

/** Неделя, по итогам которой прошло автоначисление (ТЗ 5.9). */
export class CoinWeekDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  groupId!: string;

  @ApiProperty({ example: 3, description: 'Номер недели в журнале группы' })
  weekNumber!: number;
}

/** Строка истории начислений (ТЗ 5.9). */
export class CoinTransactionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  studentId!: string;

  @ApiProperty({ example: 5, description: 'Начислено коинов; всегда положительное' })
  amount!: number;

  @ApiProperty({ example: 'Итог недели 3: 104 балла' })
  reason!: string;

  @ApiProperty({ enum: CoinSource })
  source!: CoinSource;

  @ApiPropertyOptional({ type: CoinWeekDto, nullable: true })
  week!: CoinWeekDto | null;

  @ApiPropertyOptional({ type: CoinAuthorDto, nullable: true })
  author!: CoinAuthorDto | null;

  @ApiProperty({ example: '2026-09-21T09:00:00.000Z' })
  createdAt!: string;
}

/**
 * Ответ на ручное начисление. Баланс отдаётся вместе со строкой, чтобы экран
 * не перезапрашивал историю ради одного числа.
 */
export class CoinAwardedDto {
  @ApiProperty({ type: CoinTransactionDto })
  transaction!: CoinTransactionDto;

  @ApiProperty({ example: 17, description: 'Баланс студента после начисления' })
  balance!: number;
}
