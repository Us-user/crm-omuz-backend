import { PermissionCatalogSyncService } from './permission-catalog-sync.service';
import { PERMISSION_CATALOG } from './permission-catalog';
import type { RbacRepository, StoredPermission } from './rbac.repository';

/** Строка в БД, совпадающая с каталогом, — синхронизации нечего с ней делать. */
const storedFrom = (index: number, overrides: Partial<StoredPermission> = {}): StoredPermission => {
  const definition = PERMISSION_CATALOG[index];
  if (!definition) throw new Error('Каталог пуст: тест построен неверно');

  return {
    id: `id-${index}`,
    code: definition.code,
    section: definition.section,
    action: definition.action,
    description: definition.description,
    isSystem: definition.isSystem,
    ...overrides,
  };
};

describe('PermissionCatalogSyncService', () => {
  let repository: jest.Mocked<
    Pick<
      RbacRepository,
      'findAllPermissions' | 'createPermissions' | 'updatePermission' | 'syncSystemPosition'
    >
  >;
  let service: PermissionCatalogSyncService;

  beforeEach(() => {
    repository = {
      findAllPermissions: jest.fn().mockResolvedValue([]),
      createPermissions: jest.fn().mockImplementation((rows: unknown[]) => rows.length),
      updatePermission: jest.fn().mockResolvedValue(undefined),
      syncSystemPosition: jest.fn().mockResolvedValue(0),
    };
    service = new PermissionCatalogSyncService(repository as unknown as RbacRepository);
  });

  it('на пустой БД заводит весь каталог', async () => {
    const result = await service.sync();

    expect(result.created).toBe(PERMISSION_CATALOG.length);
    expect(repository.createPermissions).toHaveBeenCalledWith(PERMISSION_CATALOG);
    expect(repository.updatePermission).not.toHaveBeenCalled();
  });

  it('на совпадающей БД не делает ни одной записи', async () => {
    repository.findAllPermissions.mockResolvedValue(
      PERMISSION_CATALOG.map((_, i) => storedFrom(i)),
    );

    const result = await service.sync();

    expect(result).toMatchObject({ created: 0, updated: 0, stale: [] });
    expect(repository.createPermissions).not.toHaveBeenCalled();
    expect(repository.updatePermission).not.toHaveBeenCalled();
  });

  it('заводит только недостающие права', async () => {
    repository.findAllPermissions.mockResolvedValue([storedFrom(0)]);

    await service.sync();

    const created = repository.createPermissions.mock.calls[0]?.[0] ?? [];
    expect(created).toHaveLength(PERMISSION_CATALOG.length - 1);
    expect(created.map((permission) => permission.code)).not.toContain(PERMISSION_CATALOG[0]?.code);
  });

  it('приводит изменившееся описание к каталогу', async () => {
    repository.findAllPermissions.mockResolvedValue([
      storedFrom(0, { description: 'Описание из прошлой версии' }),
    ]);

    const result = await service.sync();

    expect(result.updated).toBe(1);
    expect(repository.updatePermission).toHaveBeenCalledWith('id-0', PERMISSION_CATALOG[0]);
  });

  it('сообщает о правах, которых больше нет в каталоге, но не удаляет их', async () => {
    repository.findAllPermissions.mockResolvedValue([
      storedFrom(0),
      {
        id: 'id-legacy',
        code: 'Permission.Legacy.Whatever',
        section: 'Legacy',
        action: 'Whatever',
        description: null,
        isSystem: false,
      },
    ]);

    const result = await service.sync();

    // Удаление увело бы каскадом выданные позициям галочки; право просто
    // перестаёт действовать — его отбрасывает `PermissionsService`.
    expect(result.stale).toEqual(['Permission.Legacy.Whatever']);
  });

  it('выдаёт системной позиции Director права каталога', async () => {
    repository.syncSystemPosition.mockResolvedValue(7);

    const result = await service.sync();

    expect(repository.syncSystemPosition).toHaveBeenCalledWith(
      'Director',
      expect.stringContaining('Руководитель'),
    );
    expect(result.grantedToDirector).toBe(7);
  });

  it('синхронизируется при старте приложения', async () => {
    await service.onApplicationBootstrap();

    expect(repository.findAllPermissions).toHaveBeenCalled();
    expect(repository.syncSystemPosition).toHaveBeenCalled();
  });
});
