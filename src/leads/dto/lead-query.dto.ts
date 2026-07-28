import { ApiPropertyOptional } from '@nestjs/swagger';
import { LeadType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsUUID, Matches } from 'class-validator';

import { ISO_MONTH_PATTERN, PaginationQueryDto, SortOrder } from '../../common';

/** Поля, по которым разрешено сортировать список лидов. */
export enum LeadSortField {
  /** Когда обращение завели — по умолчанию, свежие сверху. */
  CreatedAt = 'createdAt',
  /** «Фамилия, имя» — как во всех списках людей в проекте. */
  Name = 'name',
  /** Месяц записи (ТЗ 5.7) — по нему планируют набор. */
  EnrollMonth = 'enrollMonth',
}

/** Тот же разбор, что у `hasAccount` в списке студентов (0014). */
const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/**
 * Список лидов (ТЗ 5.7: «фильтры по датам/курсу»).
 *
 * Наследует `PaginationQueryDto` обычным `extends`, а не `IntersectionType`:
 * геттеры `skip`/`take` живут на прототипе, и сборные классы `@nestjs/swagger`
 * их не переносят — окно страницы молча уехало бы в `undefined` (поймано
 * юнит-тестом в сессии 0025).
 *
 * Период задаётся **датой обращения** (`from`/`to`, месяцы включительно):
 * «сколько лидов пришло в сентябре» — вопрос про день обращения, а не про месяц
 * записи. Для второго есть отдельный фильтр `enrollMonth`, и путать их нельзя:
 * лид сентября вполне может записываться на ноябрь.
 */
export class LeadQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: LeadSortField, default: LeadSortField.CreatedAt })
  @IsOptional()
  @IsEnum(LeadSortField)
  override sort: LeadSortField = LeadSortField.CreatedAt;

  @ApiPropertyOptional({
    enum: SortOrder,
    default: SortOrder.Desc,
    description: 'По умолчанию свежие обращения сверху.',
  })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({
    enum: LeadType,
    description: 'Стадия обращения (ТЗ 5.7): `LEAD` или `CLIENT`.',
  })
  @IsOptional()
  @IsEnum(LeadType)
  type?: LeadType;

  @ApiPropertyOptional({ format: 'uuid', description: 'Интересующий курс.' })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Филиал записи (ТЗ 3.3).' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Обещанный купон.' })
  @IsOptional()
  @IsUUID()
  couponId?: string;

  @ApiPropertyOptional({
    example: '2026-09',
    description: '«Месяц записи» из ТЗ 5.7 — на какой месяц человек записывается.',
  })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'enrollMonth: ожидается месяц в формате YYYY-MM' })
  enrollMonth?: string;

  @ApiPropertyOptional({
    description:
      'Переведён ли лид в студенты: `true` — только переведённые, `false` — только те, ' +
      'кто ещё в воронке.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  converted?: boolean;

  @ApiPropertyOptional({
    example: '2026-01',
    description: 'Начало периода обращения: месяц `YYYY-MM` включительно.',
  })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'from: ожидается месяц в формате YYYY-MM' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-06',
    description: 'Конец периода обращения: месяц `YYYY-MM` включительно.',
  })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'to: ожидается месяц в формате YYYY-MM' })
  to?: string;
}
