import { BusinessRuleException } from '../common';
import { PermissionCatalogAdminService } from './permission-catalog-admin.service';
import { PERMISSION_CATALOG } from './permission-catalog';
import type { RbacRepository, StoredPermission } from './rbac.repository';

const stored = (index: number, overrides: Partial<StoredPermission> = {}): StoredPermission => {
  const definition = PERMISSION_CATALOG[index];
  if (!definition) throw new Error('Каталог пуст: тест построен неверно');

  return {
    id: `id-${String(index)}`,
    code: definition.code,
    section: definition.section,
    action: definition.action,
    description: definition.description,
    isEnabled: true,
    isSystem: definition.isSystem,
    ...overrides,
  };
};

const wholeCatalog = (): StoredPermission[] => PERMISSION_CATALOG.map((_, index) => stored(index));

const findStored = (rows: StoredPermission[], code: string): StoredPermission & { id: string } => {
  const row = rows.find((candidate) => candidate.code === code);
  if (!row) throw new Error(`Права ${code} нет в каталоге: тест построен неверно`);

  return row;
};

describe('PermissionCatalogAdminService', () => {
  let repository: jest.Mocked<Pick<RbacRepository, 'findAllPermissions' | 'setPermissionsEnabled'>>;
  let service: PermissionCatalogAdminService;
  let rows: StoredPermission[];

  beforeEach(() => {
    rows = wholeCatalog();
    repository = {
      findAllPermissions: jest.fn().mockImplementation(() => Promise.resolve(rows)),
      setPermissionsEnabled: jest
        .fn()
        .mockImplementation((enable: string[], disable: string[]) =>
          Promise.resolve(enable.length + disable.length),
        ),
    };

    service = new PermissionCatalogAdminService(repository as unknown as RbacRepository);
  });

  describe('Каталог', () => {
    it('отдаёт весь каталог, сгруппированный по разделам с названиями', async () => {
      const catalog = await service.getCatalog();

      expect(catalog.total).toBe(PERMISSION_CATALOG.length);

      const students = catalog.sections.find((section) => section.section === 'Students');
      expect(students?.title).toBe('Студенты');
      expect(students?.permissions.map((permission) => permission.code)).toContain(
        'Permission.Students.Views',
      );
    });

    it('фильтр по разделу оставляет один раздел', async () => {
      const catalog = await service.getCatalog('Accounting');

      expect(catalog.sections).toHaveLength(1);
      expect(catalog.sections[0]?.section).toBe('Accounting');
      expect(catalog.total).toBe(catalog.sections[0]?.permissions.length);
    });

    it('показывает состояние переключателя из БД', async () => {
      findStored(rows, 'Permission.Leads.Export').isEnabled = false;

      const catalog = await service.getCatalog('Leads');
      const exportPermission = catalog.sections[0]?.permissions.find(
        (permission) => permission.code === 'Permission.Leads.Export',
      );

      expect(exportPermission?.isEnabled).toBe(false);
    });

    it('право из БД, которого нет в каталоге кода, на экран не попадает', async () => {
      rows.push({
        id: 'id-legacy',
        code: 'Permission.Legacy.Whatever',
        section: 'Legacy',
        action: 'Whatever',
        description: null,
        isEnabled: true,
        isSystem: false,
      });

      const catalog = await service.getCatalog();

      expect(catalog.total).toBe(PERMISSION_CATALOG.length);
      expect(catalog.sections.map((section) => section.section)).not.toContain('Legacy');
    });

    it('право каталога, отсутствующее в БД, пропускается: переключать нечего', async () => {
      rows = rows.filter((row) => row.code !== 'Permission.Leads.Export');

      const catalog = await service.getCatalog('Leads');

      expect(catalog.sections[0]?.permissions.map((permission) => permission.code)).not.toContain(
        'Permission.Leads.Export',
      );
    });
  });

  describe('Переключение (ТЗ 5.15)', () => {
    it('выключает право и отдаёт обновлённый каталог', async () => {
      const target = findStored(rows, 'Permission.Leads.Export');

      await service.update({
        permissions: [{ code: 'Permission.Leads.Export', isEnabled: false }],
      });

      expect(repository.setPermissionsEnabled).toHaveBeenCalledWith([], [target.id]);
    });

    it('включает выключенное право', async () => {
      const target = findStored(rows, 'Permission.Leads.Export');
      target.isEnabled = false;

      await service.update({ permissions: [{ code: 'Permission.Leads.Export', isEnabled: true }] });

      expect(repository.setPermissionsEnabled).toHaveBeenCalledWith([target.id], []);
    });

    it('не пишет в БД, если состояние уже такое', async () => {
      await service.update({ permissions: [{ code: 'Permission.Leads.Export', isEnabled: true }] });

      expect(repository.setPermissionsEnabled).toHaveBeenCalledWith([], []);
    });

    it('422 на попытку выключить служебное право', async () => {
      await expect(
        service.update({
          permissions: [{ code: 'Permission.Administration.ManagePermissions', isEnabled: false }],
        }),
      ).rejects.toBeInstanceOf(BusinessRuleException);

      expect(repository.setPermissionsEnabled).not.toHaveBeenCalled();
    });

    it('служебное право можно оставить включённым', async () => {
      await expect(
        service.update({
          permissions: [{ code: 'Permission.Administration.ManagePermissions', isEnabled: true }],
        }),
      ).resolves.toBeDefined();
    });

    it('422 на повтор одного кода в запросе', async () => {
      await expect(
        service.update({
          permissions: [
            { code: 'Permission.Leads.Export', isEnabled: false },
            { code: 'Permission.Leads.Export', isEnabled: true },
          ],
        }),
      ).rejects.toBeInstanceOf(BusinessRuleException);

      expect(repository.setPermissionsEnabled).not.toHaveBeenCalled();
    });

    it('422, если права нет в таблице каталога', async () => {
      rows = rows.filter((row) => row.code !== 'Permission.Leads.Export');

      await expect(
        service.update({
          permissions: [{ code: 'Permission.Leads.Export', isEnabled: false }],
        }),
      ).rejects.toBeInstanceOf(BusinessRuleException);
    });

    it('запрос применяется целиком или никак: ошибка в конце отменяет всё', async () => {
      await expect(
        service.update({
          permissions: [
            { code: 'Permission.Leads.Export', isEnabled: false },
            { code: 'Permission.Administration.ViewPermissions', isEnabled: false },
          ],
        }),
      ).rejects.toBeInstanceOf(BusinessRuleException);

      expect(repository.setPermissionsEnabled).not.toHaveBeenCalled();
    });
  });
});
