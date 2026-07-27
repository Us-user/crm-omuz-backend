import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNumber, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

import { ISO_MONTH_PATTERN, trimString } from '../../common';

/**
 * Верхняя граница суммы аванса. Колонка — `DECIMAL(12,2)`, и без ограничения
 * сверху число, не влезающее в неё, дошло бы до БД и вернулось ошибкой 500
 * (то же, что со стоимостью курса в сессии 0007 и часовой ставкой в 0021).
 */
export const MAX_AVANS_AMOUNT = 9_999_999_999.99;

/** Нижняя граница: заявка на ноль сомони не просит ничего. */
export const MIN_AVANS_AMOUNT = 0.01;

/** Подача заявки на аванс (ТЗ 5.14: `POST /employees/{id}/avans`). */
export class CreateAvansRequestDto {
  @ApiProperty({
    example: 500,
    minimum: MIN_AVANS_AMOUNT,
    maximum: MAX_AVANS_AMOUNT,
    description:
      'Запрошенная сумма в сомони (TJS). Одобренная заявка вычитается из зарплаты ' +
      'месяца как `Prepaid` (ТЗ 5.16). Ноль и отрицательные значения — 400: ' +
      'заявка, которая ничего не просит, бессмысленна.',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(MIN_AVANS_AMOUNT)
  @Max(MAX_AVANS_AMOUNT)
  amount!: number;

  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    example: 'Оплата аренды жилья',
    description:
      'Причина — обязательна: заявку рассматривает другой человек (ТЗ 5.16), ' +
      'и без «зачем» решать ему нечего.',
  })
  @Transform(trimString)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @ApiProperty({
    example: '2026-09',
    pattern: ISO_MONTH_PATTERN.source,
    description:
      'Месяц зарплаты в формате `YYYY-MM`, из которой удержится аванс. ' +
      'Относится к **месяцу**, а не к дате одобрения: заявка за сентябрь, ' +
      'одобренная 2 октября, легла бы иначе не в тот расчёт (ТЗ 5.16).',
  })
  @Transform(trimString)
  @IsString()
  @Matches(ISO_MONTH_PATTERN, { message: 'month должен быть месяцем в формате YYYY-MM' })
  month!: string;
}
