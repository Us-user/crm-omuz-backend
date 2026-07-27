import { ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID, Matches } from 'class-validator';

import { ISO_MONTH_PATTERN, PaginationQueryDto, SortOrder } from '../../common';

/** По чему сортируется список покинувших. */
export enum LeftCourseSortField {
  /** Дата ухода — по умолчанию, свежие сверху. */
  LeftAt = 'leftAt',
  /** «Фамилия, имя» — как во всех списках людей в проекте. */
  Name = 'name',
}

/**
 * Список покинувших курсы (ТЗ 5.12).
 *
 * Наследует `PaginationQueryDto` обычным `extends`, а не `IntersectionType`:
 * геттеры `skip`/`take` живут на прототипе, и сборные классы `@nestjs/swagger`
 * их не переносят — окно страницы молча уехало бы в `undefined`
 * (поймано юнит-тестом на передачу окна в выборку).
 *
 * `search` здесь работает и ищет по имени, фамилии, телефону **и причине
 * ухода**: причина — свободный текст, группировать её нечем, а «кто ушёл
 * из-за переезда» — обычный вопрос к этому отчёту.
 *
 * Период задаётся **месяцами**, а не датами: ТЗ 5.12 говорит о помесячном
 * графике, и два эндпоинта одного отчёта не должны понимать `from`/`to`
 * по-разному. Границы включающие: `from=2026-01&to=2026-03` — это январь,
 * февраль и март целиком. Тот же формат и тот же `parseIsoMonth`, что
 * у истории уровней ментора (0021) и заявок на аванс (0022).
 */
export class LeftCoursesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: LeftCourseSortField,
    default: LeftCourseSortField.LeftAt,
    description: 'Поле сортировки.',
  })
  @IsOptional()
  @IsEnum(LeftCourseSortField)
  override sort: LeftCourseSortField = LeftCourseSortField.LeftAt;

  @ApiPropertyOptional({
    enum: SortOrder,
    default: SortOrder.Desc,
    description: 'По умолчанию свежие уходы сверху.',
  })
  @IsOptional()
  @IsEnum(SortOrder)
  override order: SortOrder = SortOrder.Desc;

  @ApiPropertyOptional({ format: 'uuid', description: 'Уходы из одной группы.' })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Уходы со всех групп курса.' })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Филиал **группы**, из которой ушли (ТЗ 3.3), а не филиал профиля студента.',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    example: '2026-01',
    description: 'Начало периода: месяц `YYYY-MM` включительно.',
  })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'from: ожидается месяц в формате YYYY-MM' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-06',
    description: 'Конец периода: месяц `YYYY-MM` включительно.',
  })
  @IsOptional()
  @Matches(ISO_MONTH_PATTERN, { message: 'to: ожидается месяц в формате YYYY-MM' })
  to?: string;
}

/**
 * Статистика оттока (ТЗ 5.12: помесячный график).
 *
 * Это тот же отбор без пагинации, поэтому поля не объявляются второй раз,
 * а берутся из списка: два экрана одного отчёта обязаны понимать фильтры
 * одинаково **по определению**, а не по совпадению (приём сессии 0013
 * с выгрузкой состава). Пагинации нет: это одна витрина с рядом по месяцам
 * и тремя разрезами, а страница, обрезающая график посередине, для работы
 * не годится — то же исключение из ТЗ 3.5, что у каталога прав (0006)
 * и карточки недели журнала (0018).
 */
export class LeftCoursesStatsQueryDto extends PickType(LeftCoursesQueryDto, [
  'groupId',
  'courseId',
  'branchId',
  'from',
  'to',
] as const) {}
