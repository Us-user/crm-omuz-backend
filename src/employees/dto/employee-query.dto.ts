import { ApiPropertyOptional } from '@nestjs/swagger';
import { EmployeeStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/**
 * Поля, по которым разрешено сортировать список сотрудников. Перечисление, а не
 * свободная строка из `PaginationQueryDto`: иначе значение дошло бы до `orderBy`
 * Prisma и вернулось ошибкой БД (500) на первом же неизвестном поле.
 */
export enum EmployeeSortField {
  /** «Фамилия, имя» — так список читают, и так же устроен индекс `employees`. */
  Name = 'name',
  HiredAt = 'hiredAt',
  CreatedAt = 'createdAt',
}

const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/**
 * Список сотрудников (ТЗ 5.14: «список карточками/таблицей, фильтры»).
 *
 * Конкретных фильтров ТЗ не перечисляет (в отличие от студентов и групп),
 * поэтому взяты те, по которым список режут на экранах: штатный статус, филиал
 * (ТЗ 3.3) и позиция — последняя и есть способ получить «список менторов»
 * из ТЗ 5.4, не заводя второго маршрута.
 */
export class EmployeeQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: EmployeeSortField, default: EmployeeSortField.Name })
  @IsOptional()
  @IsEnum(EmployeeSortField)
  override sort: EmployeeSortField = EmployeeSortField.Name;

  // Список людей читают по алфавиту, поэтому направление по умолчанию прямое.
  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({ enum: EmployeeStatus, description: 'Штатный статус сотрудника' })
  @IsOptional()
  @IsEnum(EmployeeStatus)
  status?: EmployeeStatus;

  @ApiPropertyOptional({ format: 'uuid', description: 'Фильтр «Branch» (ТЗ 3.3, 5.14)' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Сотрудники, занимающие эту позицию. Отсюда же берётся список менторов (ТЗ 5.4): ' +
      'ментор — это сотрудник с соответствующей позицией, а не отдельная сущность.',
  })
  @IsOptional()
  @IsUUID()
  positionId?: string;

  @ApiPropertyOptional({
    description: 'Есть ли у сотрудника аккаунт: ТЗ 5.14 называет логин опциональным.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  hasAccount?: boolean;
}
