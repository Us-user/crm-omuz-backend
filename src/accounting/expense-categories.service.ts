import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { BusinessRuleException, emptyToNullPatch } from '../common';
import { AccountingRepository } from './accounting.repository';
import type { ExpenseCategoryRow } from './accounting.repository';
import type {
  CreateExpenseCategoryDto,
  ExpenseCategoriesQueryDto,
  ExpenseCategoryCatalogDto,
  ExpenseCategoryDeletedDto,
  ExpenseCategoryDto,
  ExpenseCategoryTreeDto,
  UpdateExpenseCategoryDto,
} from './dto';

/**
 * Справочник статей расхода (ТЗ 5.16: «Expenses: категории — Tax→Income tax/
 * VAT/Property/Social, Office, Marketing, Employees»).
 *
 * Справочник **двухуровневый** (решение пользователя, сессия 0030): перечень
 * ТЗ сам задан с вложенностью, и «Tax» в нём — не расход, а свод четырёх
 * налогов. Категории из ТЗ заводит миграция; строки при этом обычные,
 * а не системные — центр вправе их переименовать и завести свои.
 *
 * Глубина в два уровня — правило **этого сервиса**, а не схемы: в схеме стоит
 * обычная ссылка на родителя, и запрет живёт там, где его можно объяснить
 * человеку. Дерево произвольной глубины пришлось бы обходить рекурсивно
 * в каждом отчёте, а третьего уровня ТЗ не знает.
 *
 * Остальные правила — общие для справочников проекта: название уникально
 * без учёта регистра (0006, 0007, 0027, 0029), использованную запись
 * не удалить (409), «вывести из работы» — это `INACTIVE`, а не удаление.
 */
@Injectable()
export class ExpenseCategoriesService {
  private readonly logger = new Logger(ExpenseCategoriesService.name);

  constructor(private readonly repository: AccountingRepository) {}

  /**
   * Справочник целиком, деревом. Не постраничный — как каталог прав (0006):
   * страница отрезала бы подкатегории от родителя, а «Налоги» без своих
   * четырёх статей не значат ничего.
   */
  async findAll(query: ExpenseCategoriesQueryDto): Promise<ExpenseCategoryCatalogDto> {
    const rows = await this.repository.findManyCategories({
      status: query.status,
      search: query.search,
    });

    const children = new Map<string, ExpenseCategoryDto[]>();
    const roots: ExpenseCategoryRow[] = [];

    for (const row of rows) {
      if (row.parent === null) {
        roots.push(row);
        continue;
      }

      children.set(row.parent.id, [...(children.get(row.parent.id) ?? []), toDto(row)]);
    }

    const categories: ExpenseCategoryTreeDto[] = roots.map((row) => ({
      ...toDto(row),
      children: children.get(row.id) ?? [],
    }));

    // Подкатегория, чей родитель не прошёл отбор (например, отфильтрован
    // по статусу), остаётся видимой строкой верхнего уровня: молча пропасть
    // из справочника она не должна — по ней проведены деньги.
    const orphans = [...children.entries()]
      .filter(([parentId]) => !roots.some((root) => root.id === parentId))
      .flatMap(([, rows_]) => rows_.map((row) => ({ ...row, children: [] })));

    return {
      total: rows.length,
      categories: [...categories, ...orphans].sort((a, b) => compareText(a.name, b.name)),
    };
  }

  async findOne(id: string): Promise<ExpenseCategoryDto> {
    return toDto(await this.require(id));
  }

  async create(dto: CreateExpenseCategoryDto): Promise<ExpenseCategoryDto> {
    await this.assertNameFree(dto.name);
    if (dto.parentId !== undefined) await this.assertParentUsable(dto.parentId);

    const category = await this.repository.createCategory({
      name: dto.name,
      description: dto.description === undefined ? null : emptyToNullPatch(dto.description),
      parentId: dto.parentId ?? null,
      status: dto.status,
    });

    this.logger.log(`Заведена категория расхода ${category.name} (${category.id})`);

    return toDto(category);
  }

  async update(id: string, dto: UpdateExpenseCategoryDto): Promise<ExpenseCategoryDto> {
    const existing = await this.require(id);

    if (dto.name !== undefined && dto.name.toLowerCase() !== existing.name.toLowerCase()) {
      await this.assertNameFree(dto.name);
    }

    // Пустая строка поднимает категорию на верхний уровень — то же правило
    // пустой строки, что у аудитории слота (0011) и разнесения предоплаты (0029).
    const parentId = dto.parentId === undefined ? undefined : emptyToNullPatch(dto.parentId);

    if (parentId !== undefined && parentId !== null) {
      if (parentId === id) {
        throw new BusinessRuleException('Категория не может быть родителем самой себе', {
          parentId,
        });
      }

      // Второй уровень — последний: категория с подкатегориями сама
      // в подкатегории не уходит, иначе дерево стало бы трёхуровневым
      // в обход правила.
      if (existing._count.children > 0) {
        throw new BusinessRuleException(
          `У категории «${existing.name}» есть подкатегории (${String(existing._count.children)}) — ` +
            'вложить её в другую нельзя: справочник двухуровневый',
          { parentId },
        );
      }

      await this.assertParentUsable(parentId);
    }

    const category = await this.repository.updateCategory(id, {
      name: dto.name,
      description: emptyToNullPatch(dto.description),
      parentId,
      status: dto.status,
    });

    this.logger.log(`Изменена категория расхода ${category.name} (${id})`);

    return toDto(category);
  }

  /**
   * Категория с расходами, с планами или с подкатегориями не удаляется (409).
   * Внешние ключи стоят `RESTRICT` и так не пустят, но наружу должна уходить
   * причина, а не обезличенная ошибка связи (0021, 0027, 0029).
   */
  async remove(id: string): Promise<ExpenseCategoryDeletedDto> {
    const category = await this.require(id);

    if (category._count.expenses > 0) {
      throw new ConflictException(
        `По категории проведены расходы (${String(category._count.expenses)}) — ` +
          'переведите её в статус «INACTIVE» вместо удаления',
      );
    }

    // Статья, которую планируют, тоже держит справочник (0031): исчезнув,
    // она оставила бы строку бюджета без предмета, и «сколько мы решили
    // потратить на маркетинг» перестало бы иметь ответ.
    if (category._count.budgetLines > 0) {
      throw new ConflictException(
        `Категория запланирована в бюджетах (${String(category._count.budgetLines)}) — ` +
          'уберите её из планов или переведите в статус «INACTIVE»',
      );
    }

    if (category._count.children > 0) {
      throw new ConflictException(
        `У категории есть подкатегории (${String(category._count.children)}) — ` +
          'удалите или перенесите сначала их',
      );
    }

    await this.repository.deleteCategory(id);
    this.logger.log(`Удалена категория расхода ${category.name} (${id})`);

    return { id, name: category.name };
  }

  private async require(id: string): Promise<ExpenseCategoryRow> {
    const category = await this.repository.findCategoryById(id);
    if (!category) {
      throw new NotFoundException('Категория расхода не найдена');
    }

    return category;
  }

  private async assertNameFree(name: string): Promise<void> {
    const twin = await this.repository.findCategoryByName(name);
    if (twin) {
      throw new ConflictException(`Категория расхода «${twin.name}» уже заведена`);
    }
  }

  /** Родителем может быть только категория верхнего уровня — уровней два. */
  private async assertParentUsable(parentId: string): Promise<void> {
    const parent = await this.repository.findCategoryById(parentId);
    if (parent === null) {
      throw new BusinessRuleException('Родительская категория не найдена', { parentId });
    }

    if (parent.parent !== null) {
      throw new BusinessRuleException(
        `Категория «${parent.name}» сама вложена в «${parent.parent.name}» — ` +
          'справочник двухуровневый, подкатегорию в подкатегорию вложить нельзя',
        { parentId },
      );
    }
  }
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const toDto = (row: ExpenseCategoryRow): ExpenseCategoryDto => ({
  id: row.id,
  name: row.name,
  description: row.description,
  parent: row.parent,
  status: row.status,
  childrenCount: row._count.children,
  expensesCount: row._count.expenses,
  budgetLinesCount: row._count.budgetLines,
  createdAt: row.createdAt.toISOString(),
});
