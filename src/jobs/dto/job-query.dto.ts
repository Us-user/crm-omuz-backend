import { ApiPropertyOptional } from '@nestjs/swagger';
import { DirectoryStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';

import { PaginationQueryDto, SortOrder } from '../../common';

/** Поля, по которым разрешено сортировать список вакансий. */
export enum JobSortField {
  Title = 'title',
  Company = 'company',
  /** «Что скоро закроется» — обычный вопрос к вакансиям, как к акциям (0027). */
  Deadline = 'deadline',
  CreatedAt = 'createdAt',
}

/** Тот же разбор, что у `currentlyValid` купона (0027) и `hasAccount` (0014). */
const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/**
 * Список вакансий для сотрудника (ТЗ 5.18).
 *
 * `sort` сужен до перечисления, как во всех списках проекта: свободная строка
 * из базового DTO попала бы в `orderBy` Prisma и вернулась бы ошибкой БД.
 */
export class JobQueryDto extends PaginationQueryDto {
  /**
   * Свежие сверху — осознанно иначе, чем у справочников (филиалы, купоны,
   * позиции читаются по алфавиту): вакансия это объявление, а не строка
   * каталога, и первым делом смотрят, что появилось.
   */
  @ApiPropertyOptional({ enum: JobSortField, default: JobSortField.CreatedAt })
  @IsOptional()
  @IsEnum(JobSortField)
  override sort: JobSortField = JobSortField.CreatedAt;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Desc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({ enum: DirectoryStatus, description: 'Active/Inactive.' })
  @IsOptional()
  @IsEnum(DirectoryStatus)
  status?: DirectoryStatus;

  @ApiPropertyOptional({
    description:
      'Актуальна ли вакансия **сегодня**: `true` — только `ACTIVE`, чей срок не прошёл ' +
      '(включая бессрочные), `false` — выключенные и просроченные. Отличается ' +
      'от `status`: вакансия бывает включённой, но с истёкшим сроком.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  open?: boolean;
}

/**
 * Список вакансий в кабинете студента (`GET /me/jobs`).
 *
 * Отдельный DTO, а не `JobQueryDto`: студенту нечего фильтровать по `status`
 * и `open` — он видит **только** актуальные, и отбор задан не запросом,
 * а самим маршрутом. Оставить фильтры значило бы разрешить `?open=false`,
 * то есть показать снятые вакансии тому, кому их показывать не собирались.
 */
export class MeJobQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: JobSortField, default: JobSortField.CreatedAt })
  @IsOptional()
  @IsEnum(JobSortField)
  override sort: JobSortField = JobSortField.CreatedAt;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.Desc })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;
}
