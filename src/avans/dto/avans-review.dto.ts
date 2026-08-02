import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AvansStatus, EmployeeStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { ISO_MONTH_PATTERN, PaginationQueryDto, SortOrder, trimString } from '../../common';
import { AvansSortField } from './avans-query.dto';
import { AvansRequestDto } from './avans-response.dto';

/** Сотрудник, которому просят аванс, — в очереди он в каждой строке. */
export class AvansSubjectDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Фаррух' })
  firstName!: string;

  @ApiProperty({ example: 'Раҳимов' })
  lastName!: string;

  @ApiProperty({
    enum: EmployeeStatus,
    description:
      'Статус сотрудника. Выведенному из штата (`INACTIVE`) аванс не одобряется (422): ' +
      'выплата тому, кого в штате нет, — состояние, которого не должно быть.',
  })
  status!: EmployeeStatus;
}

/** Строка очереди рассмотрения (ТЗ 5.16: «Avans: заявка ментора → Approve/Deny»). */
export class AvansReviewRequestDto extends AvansRequestDto {
  @ApiProperty({ type: AvansSubjectDto, description: 'Кому аванс.' })
  employee!: AvansSubjectDto;
}

/**
 * Очередь заявок бухгалтерии (ТЗ 5.16: `GET /accounting/avans`).
 *
 * В отличие от списка внутри `/employees/{id}/avans` (0022), здесь есть
 * `search`: очередь идёт по всему центру, и «найти заявку Каримова» — обычный
 * вопрос к этому экрану. Ищется по имени, фамилии и причине.
 */
export class AvansReviewQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: AvansSortField, default: AvansSortField.CreatedAt })
  @IsOptional()
  @IsEnum(AvansSortField)
  override sort: AvansSortField = AvansSortField.CreatedAt;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Desc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({
    enum: AvansStatus,
    description: 'Без фильтра очередь показывает все заявки; `PENDING` — только ждущие решения.',
  })
  @IsOptional()
  @IsEnum(AvansStatus)
  status?: AvansStatus;

  @ApiPropertyOptional({ format: 'uuid', description: 'Только заявки этого сотрудника.' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ example: '2026-01', description: 'С этого месяца зарплаты включительно.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(ISO_MONTH_PATTERN, { message: 'from должен быть месяцем в формате YYYY-MM' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-12', description: 'По этот месяц зарплаты включительно.' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(ISO_MONTH_PATTERN, { message: 'to должен быть месяцем в формате YYYY-MM' })
  to?: string;
}

/**
 * Одобрение (ТЗ 5.16: «Approve/Deny (сумма + причина)»).
 *
 * Комментарий необязателен: одобрение — согласие с тем, что уже написано
 * в заявке, и требовать объяснять «да» значило бы заставлять писать «ок».
 */
export class ApproveAvansDto {
  @ApiPropertyOptional({ maxLength: 1000, example: 'Одобрено в полном объёме' })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

/**
 * Отказ. Комментарий здесь **обязателен** — в этом и асимметрия с одобрением:
 * человек, которому отказали, должен узнать почему, а через полгода отказ
 * без объяснения неотличим от ошибки оператора (тот же довод, что у причины
 * смены статуса состава, 0012, и скидки, 0029).
 */
export class DenyAvansDto {
  @ApiProperty({ minLength: 3, maxLength: 1000, example: 'Превышает половину оклада' })
  @Transform(trimString)
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  comment!: string;
}

/**
 * Снятие рассмотрения — возврат заявки в `PENDING`.
 *
 * Причина обязательна: решение о деньгах отменяется, и след этого должен
 * остаться хотя бы в логе (до `AuditLog` Фазы 13).
 */
export class ReopenAvansDto {
  @ApiProperty({ minLength: 3, maxLength: 1000, example: 'Одобрено по ошибке, не тот сотрудник' })
  @Transform(trimString)
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}
