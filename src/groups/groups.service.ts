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
import type {
  CreateGroupDto,
  GroupDeletedDto,
  GroupDto,
  GroupQueryDto,
  UpdateGroupDto,
} from './dto';
import type { GroupRow } from './groups.repository';
import { GroupsRepository } from './groups.repository';

/**
 * Учебные группы (ТЗ 5.5) — узел учебного контура: на группу будут ссылаться
 * расписание (ТЗ 5.10), журнал (ТЗ 5.8) и состав студентов.
 *
 * Правила модуля:
 *   - курс и филиал обязательны и должны существовать (422, а не 404: ресурс
 *     из пути найден, не найдено то, что пришло в теле);
 *   - название уникально **внутри филиала**, без учёта регистра (409) — как
 *     у аудиторий: «Frontend-1» набирают в каждом филиале;
 *   - дата окончания не может быть раньше даты начала (400).
 */
@Injectable()
export class GroupsService {
  private readonly logger = new Logger(GroupsService.name);

  constructor(private readonly repository: GroupsRepository) {}

  async findAll(query: GroupQueryDto): Promise<Paginated<GroupDto>> {
    const { rows, total } = await this.repository.findMany({
      search: query.search,
      branchId: query.branchId,
      courseId: query.courseId,
      status: query.status,
      format: query.format,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toDto), total, query);
  }

  async findOne(id: string): Promise<GroupDto> {
    return toDto(await this.require(id));
  }

  async create(dto: CreateGroupDto): Promise<GroupDto> {
    await this.assertCourseExists(dto.courseId);
    await this.assertBranchExists(dto.branchId);
    await this.assertNameFree(dto.branchId, dto.name);

    const startDate = optionalDate(dto.startDate, 'startDate');
    const endDate = optionalDate(dto.endDate, 'endDate');
    assertPeriodOrdered(startDate, endDate);

    const durationValue = dto.durationValue ?? null;
    assertDurationPaired(durationValue, dto.durationUnit);

    const group = await this.repository.create({
      name: dto.name,
      description: emptyToNull(dto.description),
      courseId: dto.courseId,
      branchId: dto.branchId,
      format: dto.format,
      startDate,
      endDate,
      durationValue,
      durationUnit: dto.durationUnit,
      capacity: dto.capacity ?? null,
      status: dto.status,
      telegramUrl: emptyToNull(dto.telegramUrl),
    });

    this.logger.log(
      `Создана группа ${group.name} (курс ${group.course.title}, филиал ${group.branch.name}, ${group.id})`,
    );

    return toDto(group);
  }

  async update(id: string, dto: UpdateGroupDto): Promise<GroupDto> {
    const existing = await this.require(id);

    if (dto.courseId !== undefined && dto.courseId !== existing.course.id) {
      await this.assertCourseExists(dto.courseId);
    }

    // Филиал берётся из запроса, если его меняют, иначе — текущий: тёзку нужно
    // искать там, где группа окажется после правки, а не в прежнем филиале.
    const branchId = dto.branchId ?? existing.branch.id;
    if (dto.branchId !== undefined && dto.branchId !== existing.branch.id) {
      await this.assertBranchExists(dto.branchId);
    }

    if (dto.name !== undefined || branchId !== existing.branch.id) {
      await this.assertNameFree(branchId, dto.name ?? existing.name, id);
    }

    // Сроки проверяются в том виде, в котором группа окажется после правки:
    // передан может быть только один из двух, и сравнивать его нужно с тем,
    // что уже лежит в БД, а не с пустотой.
    const startDate =
      dto.startDate === undefined ? existing.startDate : optionalDate(dto.startDate, 'startDate');
    const endDate =
      dto.endDate === undefined ? existing.endDate : optionalDate(dto.endDate, 'endDate');
    assertPeriodOrdered(startDate, endDate);

    const durationValue = dto.durationValue ?? existing.durationValue;
    assertDurationPaired(durationValue, dto.durationUnit);

    const group = await this.repository.update(id, {
      name: dto.name,
      description: emptyToNullPatch(dto.description),
      courseId: dto.courseId,
      branchId: dto.branchId,
      format: dto.format,
      startDate: dto.startDate === undefined ? undefined : startDate,
      endDate: dto.endDate === undefined ? undefined : endDate,
      durationValue: dto.durationValue,
      durationUnit: dto.durationUnit,
      capacity: dto.capacity,
      status: dto.status,
      telegramUrl: emptyToNullPatch(dto.telegramUrl),
    });

    this.logger.log(`Изменена группа ${group.name} (${group.id})`);

    return toDto(group);
  }

  /**
   * Удаление группы. Ограничений пока нет: расписание, состав студентов и
   * журнал появятся следующими кусками Фазы 3 и Фазой 5 — тогда сюда встанет
   * та же проверка «к группе привязаны…», что уже стоит в филиалах.
   */
  async remove(id: string): Promise<GroupDeletedDto> {
    const group = await this.require(id);

    await this.repository.delete(id);
    this.logger.log(`Удалена группа ${group.name} (${id})`);

    return { id: group.id, name: group.name };
  }

  private async require(id: string): Promise<GroupRow> {
    const group = await this.repository.findById(id);
    if (!group) {
      throw new NotFoundException('Группа не найдена');
    }

    return group;
  }

  private async assertBranchExists(branchId: string): Promise<void> {
    const branch = await this.repository.findBranch(branchId);
    if (!branch) {
      throw new BusinessRuleException('Филиал не найден', { branchId });
    }
  }

  private async assertCourseExists(courseId: string): Promise<void> {
    const course = await this.repository.findCourse(courseId);
    if (!course) {
      throw new BusinessRuleException('Курс не найден', { courseId });
    }
  }

  private async assertNameFree(branchId: string, name: string, exceptId?: string): Promise<void> {
    const twin = await this.repository.findByName(branchId, name);
    if (twin && twin.id !== exceptId) {
      throw new ConflictException(`Группа «${twin.name}» в этом филиале уже есть`);
    }
  }
}

/** Пустая строка — «поле очистить», как у текстовых полей формы. */
const optionalDate = (value: string | undefined, field: string): Date | null =>
  value === undefined || value === '' ? null : parseIsoDate(value, field);

/**
 * Порядок сроков. 400, а не 422: это противоречие внутри самого запроса,
 * а не нарушение правила предметной области — тем же кодом отвечает разбор
 * несуществующей даты (`parseIsoDate`).
 */
function assertPeriodOrdered(startDate: Date | null, endDate: Date | null): void {
  if (startDate === null || endDate === null) return;
  if (endDate.getTime() >= startDate.getTime()) return;

  throw new BadRequestException({
    message: 'Дата окончания раньше даты начала',
    details: { endDate: `Не может быть раньше ${formatIsoDate(startDate)}` },
  });
}

/**
 * Единица длительности без самой длительности ничего не значит: в БД осталась
 * бы группа «в месяцах», но неизвестно во сколько. Проверяется по итоговому
 * состоянию — при правке число может уже лежать в базе.
 */
function assertDurationPaired(durationValue: number | null, durationUnit?: string): void {
  if (durationUnit === undefined || durationValue !== null) return;

  throw new BadRequestException({
    message: 'Единица длительности задана без значения',
    details: { durationValue: 'Обязательно, если передан durationUnit' },
  });
}

const toDto = (row: GroupRow): GroupDto => ({
  id: row.id,
  name: row.name,
  description: row.description,
  course: row.course,
  branch: row.branch,
  format: row.format,
  // Столбцы `@db.Date`: наружу уходит календарная дата без времени.
  startDate: row.startDate === null ? null : formatIsoDate(row.startDate),
  endDate: row.endDate === null ? null : formatIsoDate(row.endDate),
  durationValue: row.durationValue,
  durationUnit: row.durationUnit,
  capacity: row.capacity,
  status: row.status,
  telegramUrl: row.telegramUrl,
  createdAt: row.createdAt.toISOString(),
});
