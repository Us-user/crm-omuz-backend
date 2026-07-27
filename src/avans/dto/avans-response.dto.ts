import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AvansStatus } from '@prisma/client';

/** Сотрудник, участвовавший в судьбе заявки: кто завёл и кто рассмотрел. */
export class AvansActorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Фаррух' })
  firstName!: string;

  @ApiProperty({ example: 'Раҳимов' })
  lastName!: string;
}

/**
 * Итог рассмотрения (ТЗ 5.16: «Approve/Deny (сумма + причина)»).
 *
 * `null`, пока заявка в статусе `PENDING`. Сами маршруты рассмотрения —
 * бухгалтерия (`/accounting/avans/{id}/approve|deny`, Фаза 9); здесь это
 * поле только читается.
 */
export class AvansReviewDto {
  @ApiPropertyOptional({
    type: AvansActorDto,
    nullable: true,
    description: 'Кто рассмотрел; `null`, если его профиль удалён',
  })
  reviewedBy!: AvansActorDto | null;

  @ApiProperty({ example: '2026-09-05T08:30:00.000Z' })
  reviewedAt!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Одобрено в полном объёме' })
  comment!: string | null;
}

/** Заявка на аванс (ТЗ 5.14). */
export class AvansRequestDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  employeeId!: string;

  @ApiProperty({
    example: 500,
    description:
      'Запрошенная сумма в сомони. Хранится как DECIMAL(12,2); в JSON отдаётся ' +
      'числом — два знака после запятой в этом диапазоне представимы точно.',
  })
  amount!: number;

  @ApiProperty({ example: 'Оплата аренды жилья' })
  reason!: string;

  @ApiProperty({
    example: '2026-09',
    description: 'Месяц зарплаты в формате `YYYY-MM`. Дня в нём нет: в столбце он всегда первый.',
  })
  month!: string;

  @ApiProperty({ enum: AvansStatus })
  status!: AvansStatus;

  @ApiPropertyOptional({
    type: AvansActorDto,
    nullable: true,
    description: 'Кто завёл заявку; `null`, если у аккаунта нет профиля сотрудника',
  })
  createdBy!: AvansActorDto | null;

  @ApiPropertyOptional({
    type: AvansReviewDto,
    nullable: true,
    description: 'Итог рассмотрения; `null`, пока заявка ждёт решения',
  })
  review!: AvansReviewDto | null;

  @ApiProperty({ example: '2026-09-01T09:00:00.000Z' })
  createdAt!: string;
}

/** Ответ на отзыв заявки — чтобы интерфейс мог назвать отозванное. */
export class AvansRequestCancelledDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  employeeId!: string;

  @ApiProperty({ example: 500 })
  amount!: number;

  @ApiProperty({ example: '2026-09' })
  month!: string;
}
