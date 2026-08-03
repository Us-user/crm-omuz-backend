import { ApiPropertyOptional } from '@nestjs/swagger';
import { StudentStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/**
 * Поля, по которым разрешено сортировать список студентов. Перечисление, а не
 * свободная строка из `PaginationQueryDto`: иначе значение дошло бы до `orderBy`
 * Prisma и вернулось ошибкой БД (500) на первом же неизвестном поле.
 */
export enum StudentSortField {
  /** «Фамилия, имя» — так список читают, и так же устроен индекс `students`. */
  Name = 'name',
  CreatedAt = 'createdAt',
}

const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/**
 * Список студентов (ТЗ 5.3: фильтры name / Group / Course / Status).
 *
 * Фильтра «Contract» здесь нет: модели договора ещё не существует (ТЗ 5.3
 * заводит её вместе с `POST /students/{id}/contracts`), и любой ответ на такой
 * фильтр был бы выдумкой.
 */
export class StudentQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: StudentSortField, default: StudentSortField.Name })
  @IsOptional()
  @IsEnum(StudentSortField)
  override sort: StudentSortField = StudentSortField.Name;

  // Список людей читают по алфавиту, поэтому направление по умолчанию прямое.
  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Asc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Asc;

  @ApiPropertyOptional({ enum: StudentStatus, description: 'Фильтр «Status» из ТЗ 5.3' })
  @IsOptional()
  @IsEnum(StudentStatus)
  status?: StudentStatus;

  @ApiPropertyOptional({ format: 'uuid', description: 'Фильтр «Branch» (ТЗ 3.3)' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Фильтр «Group»: студенты, действующие членства которых в этой группе',
  })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Фильтр «Course»: студенты, действующие членства которых в группах этого курса',
  })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional({
    description:
      'Есть ли у студента аккаунт. `false` даёт список тех, кого стоит пригласить (ТЗ 5.3: Invite).',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  hasAccount?: boolean;

  @ApiPropertyOptional({
    description: 'Есть ли у студента хоть один договор. `true` даёт список студентов с договором.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  hasContract?: boolean;

  @ApiPropertyOptional({
    enum: ['ACTIVE', 'EXPIRED', 'TERMINATED'],
    description: 'Фильтр по статусу договора студента (ТЗ 5.3)',
  })
  @IsOptional()
  @IsEnum(['ACTIVE', 'EXPIRED', 'TERMINATED'])
  contractStatus?: 'ACTIVE' | 'EXPIRED' | 'TERMINATED';
}
