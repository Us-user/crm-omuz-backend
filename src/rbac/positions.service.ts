import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { BusinessRuleException, Paginated } from '../common';
import type {
  CreatePositionDto,
  PositionDeletedDto,
  PositionDto,
  PositionListItemDto,
  PositionQueryDto,
  UpdatePositionDto,
} from './dto';
import type { PermissionCode } from './permission-catalog';
import { permissionSectionOf } from './permission-catalog';
import type { PositionDetailRow, PositionListRow } from './positions.repository';
import { PositionsRepository } from './positions.repository';
import { DIRECTOR_ONLY_SECTIONS, DIRECTOR_POSITION_NAME } from './rbac.constants';

/**
 * Справочник позиций (ТЗ 5.14) — он же справочник ролей доступа (ТЗ 5.15).
 *
 * Права позиции задаются галочками из каталога (ТЗ 3.2), поэтому три правила
 * этого сервиса охраняют доступ ко всей системе:
 *   1. **системную позицию `Director` менять и удалять нельзя** — на неё опирается
 *      правило доступа к бухгалтерии, а полный набор прав ей возвращает
 *      синхронизация каталога при старте;
 *   2. **права разделов из `DIRECTOR_ONLY_SECTIONS` выдаются только ей**
 *      (ТЗ 3.2: «раздел Accounting виден только позиции Director»);
 *   3. **позицию с сотрудниками нельзя удалить** — удаление молча забрало бы
 *      у них права каскадом.
 */
@Injectable()
export class PositionsService {
  private readonly logger = new Logger(PositionsService.name);

  constructor(private readonly repository: PositionsRepository) {}

  async findAll(query: PositionQueryDto): Promise<Paginated<PositionListItemDto>> {
    const { rows, total } = await this.repository.findMany({
      search: query.search,
      sort: query.sort,
      order: query.order,
      skip: query.skip,
      take: query.take,
    });

    return Paginated.from(rows.map(toListItem), total, query);
  }

  async findOne(id: string): Promise<PositionDto> {
    return toDetail(await this.require(id));
  }

  async create(dto: CreatePositionDto): Promise<PositionDto> {
    await this.assertNameFree(dto.name);

    const codes = dto.permissions ?? [];
    this.assertSectionsAllowed(codes);

    const position = await this.repository.create({
      name: dto.name,
      description: emptyToNull(dto.description),
      permissionIds: await this.resolvePermissionIds(codes),
    });

    this.logger.log(
      `Создана позиция ${position.name} (${position.id}), прав выдано: ${String(codes.length)}`,
    );

    return toDetail(position);
  }

  async update(id: string, dto: UpdatePositionDto): Promise<PositionDto> {
    const existing = await this.require(id);
    this.assertMutable(existing);

    if (dto.name !== undefined) {
      await this.assertNameFree(dto.name, id);
    }

    const codes = dto.permissions;
    if (codes !== undefined) {
      this.assertSectionsAllowed(codes);
    }

    const position = await this.repository.update(id, {
      name: dto.name,
      description: dto.description === undefined ? undefined : emptyToNull(dto.description),
      permissionIds: codes === undefined ? undefined : await this.resolvePermissionIds(codes),
    });

    this.logger.log(
      `Изменена позиция ${position.name} (${position.id})` +
        (codes === undefined ? '' : `, прав стало: ${String(codes.length)}`),
    );

    return toDetail(position);
  }

  async remove(id: string): Promise<PositionDeletedDto> {
    const existing = await this.require(id);
    this.assertMutable(existing);

    // Каскад `employee_positions` унёс бы назначения молча: сотрудники просто
    // потеряли бы часть прав, и восстановить, какие именно, было бы нечем.
    if (existing._count.employees > 0) {
      throw new ConflictException(
        `Позицию занимают сотрудники (${String(existing._count.employees)}) — ` +
          'снимите её с них перед удалением',
      );
    }

    await this.repository.delete(id);
    this.logger.log(`Удалена позиция ${existing.name} (${id})`);

    return { id: existing.id, name: existing.name };
  }

  private async require(id: string): Promise<PositionDetailRow> {
    const position = await this.repository.findById(id);
    if (!position) {
      throw new NotFoundException('Позиция не найдена');
    }

    return position;
  }

  private assertMutable(position: { isSystem: boolean; name: string }): void {
    if (position.isSystem) {
      throw new BusinessRuleException(
        `Системную позицию ${position.name} изменять и удалять нельзя: ` +
          'на неё опирается правило доступа к бухгалтерии, и она всегда держит весь каталог прав',
      );
    }
  }

  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    const twin = await this.repository.findByName(name);
    if (twin && twin.id !== exceptId) {
      throw new ConflictException(`Позиция с названием «${twin.name}» уже существует`);
    }
  }

  /** ТЗ 3.2: раздел Accounting виден только позиции Director. */
  private assertSectionsAllowed(codes: readonly PermissionCode[]): void {
    const forbidden = codes.filter((code) =>
      DIRECTOR_ONLY_SECTIONS.includes(permissionSectionOf(code)),
    );

    if (forbidden.length === 0) return;

    const sections = [...new Set(forbidden.map(permissionSectionOf))].join(', ');
    throw new BusinessRuleException(
      `Права раздела ${sections} выдаются только позиции ${DIRECTOR_POSITION_NAME}`,
      forbidden,
    );
  }

  /**
   * Коды каталога → идентификаторы строк `permissions`.
   *
   * Расхождение означает, что таблица отстала от каталога в коде (синхронизация
   * не отработала). Молча выдать позиции меньше прав, чем просили, нельзя:
   * администратор увидел бы сохранённую галочку, которой нет.
   */
  private async resolvePermissionIds(codes: readonly PermissionCode[]): Promise<string[]> {
    if (codes.length === 0) return [];

    const rows = await this.repository.findPermissionsByCodes(codes);
    if (rows.length !== codes.length) {
      const found = new Set(rows.map((row) => row.code));
      throw new BusinessRuleException(
        'Часть прав отсутствует в каталоге базы данных',
        codes.filter((code) => !found.has(code)),
      );
    }

    return rows.map((row) => row.id);
  }
}

/** Пустая строка из формы означает «очистить поле», а не «описание из пробелов». */
const emptyToNull = (value: string | undefined): string | null =>
  value === undefined || value === '' ? null : value;

const toListItem = (row: PositionListRow): PositionListItemDto => ({
  id: row.id,
  name: row.name,
  description: row.description,
  isSystem: row.isSystem,
  permissionsCount: row._count.permissions,
  employeesCount: row._count.employees,
  createdAt: row.createdAt.toISOString(),
});

const toDetail = (row: PositionDetailRow): PositionDto => ({
  ...toListItem(row),
  // Порядок кодов задаём здесь: сортировать связку в БД дороже, чем несколько
  // десятков строк в памяти, а экрану нужен предсказуемый список.
  permissions: row.permissions.map(({ permission }) => permission.code).sort(),
});
