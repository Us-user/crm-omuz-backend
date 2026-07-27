import { ApiPropertyOptional } from '@nestjs/swagger';
import { GraduateEmployment } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsUUID, Matches } from 'class-validator';

import { ISO_MONTH_PATTERN, PaginationQueryDto, SortOrder } from '../../common';

/** По чему сортируется список выпускников. */
export enum GraduateSortField {
  /** Дата выпуска — по умолчанию, свежие сверху. */
  GraduatedAt = 'graduatedAt',
  /** «Фамилия, имя» — как во всех списках людей в проекте. */
  Name = 'name',
  /** Общий балл на момент выпуска (ТЗ 5.11: «Points»). */
  Points = 'points',
}

/** Тот же разбор, что у `hasAccount` в списке студентов (сессия 0014). */
const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/**
 * Список выпускников (ТЗ 5.11).
 *
 * Наследует `PaginationQueryDto` обычным `extends`, а не `IntersectionType`:
 * геттеры `skip`/`take` живут на прототипе, и сборные классы `@nestjs/swagger`
 * их не переносят — окно страницы молча уехало бы в `undefined` (поймано
 * юнит-тестом в сессии 0025).
 *
 * Период задаётся **месяцами**, как во всех отчётах проекта (0021, 0022, 0025):
 * границы включающие, `from=2026-01&to=2026-03` — январь, февраль и март
 * целиком. Он необязателен целиком: у витрины выпускников нет графика,
 * которому нужна ось, и открытый конец остаётся открытым.
 */
export class GraduatesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: GraduateSortField,
    default: GraduateSortField.GraduatedAt,
    description: 'Поле сортировки.',
  })
  @IsOptional()
  @IsEnum(GraduateSortField)
  override sort: GraduateSortField = GraduateSortField.GraduatedAt;

  @ApiPropertyOptional({
    enum: SortOrder,
    default: SortOrder.Desc,
    description: 'По умолчанию свежие выпуски сверху.',
  })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({ format: 'uuid', description: 'Выпускники одной группы («вид Groups»).' })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Выпускники всех групп курса.' })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Филиал **группы**, из которой выпустились (ТЗ 3.3), а не филиал профиля.',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    enum: GraduateEmployment,
    description:
      'Статус трудоустройства (ТЗ 5.11). Тех, у кого статус не выяснен, этот фильтр ' +
      'не выбирает — их число видно в `meta.employment.unknown`.',
  })
  @IsOptional()
  @IsEnum(GraduateEmployment)
  employment?: GraduateEmployment;

  @ApiPropertyOptional({
    description: 'Выдан ли сертификат: `true` — только с серийным номером, `false` — только без.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  hasCertificate?: boolean;

  @ApiPropertyOptional({
    example: '2026-01',
    description: 'Начало периода выпуска: месяц `YYYY-MM` включительно.',
  })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'from: ожидается месяц в формате YYYY-MM' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-06',
    description: 'Конец периода выпуска: месяц `YYYY-MM` включительно.',
  })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'to: ожидается месяц в формате YYYY-MM' })
  to?: string;
}
