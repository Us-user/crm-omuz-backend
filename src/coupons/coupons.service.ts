import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  BusinessRuleException,
  emptyToNull,
  emptyToNullPatch,
  formatIsoDate,
  Paginated,
  parseIsoDate,
} from '../common';
import { isCouponValidOn } from './coupons';
import type { CouponRow } from './coupons.repository';
import { CouponsRepository } from './coupons.repository';
import type {
  CouponDeletedDto,
  CouponDto,
  CouponQueryDto,
  CreateCouponDto,
  UpdateCouponDto,
} from './dto';

/**
 * Купоны (ТЗ 5.7).
 *
 * В v1 это **справочник**: применение купона к оплате отложено (ТЗ §6), поэтому
 * купон нигде не уменьшает сумму — он выбирается в карточке лида и печатается
 * в рекламе. Отсюда и состав правил: уникальное название, непротиворечивый
 * период, мультивыбор курсов и запрет на удаление обещанного кому-то купона.
 */
@Injectable()
export class CouponsService {
  private readonly logger = new Logger(CouponsService.name);

  constructor(private readonly repository: CouponsRepository) {}

  async findAll(query: CouponQueryDto): Promise<Paginated<CouponDto>> {
    const on = today();

    const { rows, total } = await this.repository.findMany({
      search: query.search,
      status: query.status,
      courseId: query.courseId,
      currentlyValid: query.currentlyValid,
      on,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(
      rows.map((row) => toDto(row, on)),
      total,
      query,
    );
  }

  async findOne(id: string): Promise<CouponDto> {
    return toDto(await this.require(id), today());
  }

  async create(dto: CreateCouponDto): Promise<CouponDto> {
    await this.assertNameFree(dto.name);

    const validFrom = optionalDate(dto.validFrom, 'validFrom');
    const validTo = optionalDate(dto.validTo, 'validTo');
    assertPeriod(validFrom, validTo);

    const courseIds = await this.resolveCourses(dto.courseIds);

    const coupon = await this.repository.create(
      {
        name: dto.name,
        description: emptyToNull(dto.description),
        amount: dto.amount,
        validFrom,
        validTo,
        status: dto.status,
      },
      courseIds ?? [],
    );

    this.logger.log(`Создан купон ${coupon.name} (${coupon.id})`);

    return toDto(coupon, today());
  }

  async update(id: string, dto: UpdateCouponDto): Promise<CouponDto> {
    const existing = await this.require(id);

    if (dto.name !== undefined) {
      await this.assertNameFree(dto.name, id);
    }

    const validFrom = optionalDatePatch(dto.validFrom, 'validFrom');
    const validTo = optionalDatePatch(dto.validTo, 'validTo');
    // Период проверяется по **итоговому** состоянию: передать можно одну
    // границу, и сравнивать её с пустотой значило бы пропускать «конец раньше
    // существующего начала» — тот же приём, что со сроками группы (0008)
    // и с границами недели журнала (0018).
    assertPeriod(
      validFrom === undefined ? existing.validFrom : validFrom,
      validTo === undefined ? existing.validTo : validTo,
    );

    const courseIds = await this.resolveCourses(dto.courseIds);

    const coupon = await this.repository.update(
      id,
      {
        name: dto.name,
        description: emptyToNullPatch(dto.description),
        amount: dto.amount,
        validFrom,
        validTo,
        status: dto.status,
      },
      courseIds,
    );

    this.logger.log(`Изменён купон ${coupon.name} (${coupon.id})`);

    return toDto(coupon, today());
  }

  /**
   * Удаление. Купон, обещанный хотя бы одному лиду, не удаляется (409) —
   * внешний ключ стоит `RESTRICT` и так не пустит, но наружу должна уходить
   * причина, а не обезличенная ошибка связи. Седьмой раз то же решение: филиал
   * с записями (0007), курс с группами (0008), позиция с сотрудниками (0006),
   * группа с составом (0012), студент с историей (0014), сотрудник со следами
   * работы (0020), ступень ментора с месяцами (0021).
   *
   * Мультивыбор курсов при этом уходит каскадом: он часть самого купона.
   */
  async remove(id: string): Promise<CouponDeletedDto> {
    const coupon = await this.require(id);

    if (coupon._count.leads > 0) {
      throw new ConflictException(
        `Купон обещан лидам (${String(coupon._count.leads)}) — переведите его ` +
          'в Inactive вместо удаления',
      );
    }

    await this.repository.delete(id);
    this.logger.log(`Удалён купон ${coupon.name} (${id})`);

    return { id: coupon.id, name: coupon.name };
  }

  private async require(id: string): Promise<CouponRow> {
    const coupon = await this.repository.findById(id);
    if (!coupon) {
      throw new NotFoundException('Купон не найден');
    }

    return coupon;
  }

  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    const twin = await this.repository.findByName(name);
    if (twin && twin.id !== exceptId) {
      throw new ConflictException(`Купон с названием «${twin.name}» уже существует`);
    }
  }

  /**
   * Курсы мультивыбора: повторы отбрасываются, несуществующие — 422
   * с перечислением **только недостающих**, а не всего присланного списка
   * (правило «Show to group», 0009). 422, а не 404: ресурс из пути найден,
   * не найдено то, что пришло в теле.
   */
  private async resolveCourses(courseIds?: string[]): Promise<string[] | undefined> {
    if (courseIds === undefined) return undefined;

    const unique = [...new Set(courseIds)];
    if (unique.length === 0) return [];

    const found = await this.repository.findCourses(unique);
    const known = new Set(found.map((course) => course.id));
    const missing = unique.filter((id) => !known.has(id));

    if (missing.length > 0) {
      throw new BusinessRuleException('Часть курсов не найдена', { courseIds: missing });
    }

    return unique;
  }
}

/**
 * Полночь сегодняшнего дня по UTC — с ней сверяется период действия.
 * Колонки `validFrom`/`validTo` объявлены `@db.Date`, и сравнивать их
 * с текущим временем значило бы объявлять купон «до 30 ноября» истёкшим
 * тридцатого в 00:01. Часовой пояс центра (UTC+5) не учитывается: весь проект
 * работает с календарём в UTC (0021, 0023, 0026).
 */
const today = (): Date => {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

/** Пустая строка снимает границу периода, отсутствие поля — оставляет как есть. */
const optionalDate = (value: string | undefined, field: string): Date | null =>
  value === undefined || value === '' ? null : parseIsoDate(value, field);

const optionalDatePatch = (value: string | undefined, field: string): Date | null | undefined =>
  value === undefined ? undefined : optionalDate(value, field);

/**
 * Конец периода не может быть раньше начала — 400, а не 422: это противоречие
 * внутри самого запроса, а не нарушение правила предметной области (то же
 * решение, что со сроками группы, 0008). Однодневная акция допустима.
 */
const assertPeriod = (validFrom: Date | null, validTo: Date | null): void => {
  if (validFrom !== null && validTo !== null && validTo.getTime() < validFrom.getTime()) {
    throw new BadRequestException({
      message: 'Конец периода раньше его начала',
      details: { validTo: 'Дата окончания не может быть раньше даты начала' },
    });
  }
};

/** `Decimal` в число — через `Number()`, а не `Decimal.toNumber()` (приём 0007). */
const toDto = (row: CouponRow, on: Date): CouponDto => ({
  id: row.id,
  name: row.name,
  description: row.description,
  amount: Number(row.amount),
  // Столбцы `@db.Date`: наружу уходит календарная дата без времени.
  validFrom: row.validFrom === null ? null : formatIsoDate(row.validFrom),
  validTo: row.validTo === null ? null : formatIsoDate(row.validTo),
  status: row.status,
  courses: row.courses.map(({ course }) => course),
  isCurrentlyValid: isCouponValidOn(row, on),
  leadsCount: row._count.leads,
  createdAt: row.createdAt.toISOString(),
});
