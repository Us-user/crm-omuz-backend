import { PermissionsService } from './permissions.service';
import type { RbacRepository } from './rbac.repository';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';

describe('PermissionsService', () => {
  let repository: jest.Mocked<Pick<RbacRepository, 'findAccountPermissionCodes'>>;
  let service: PermissionsService;

  const grant = (...codes: string[]): void => {
    repository.findAccountPermissionCodes.mockResolvedValue(codes.map((code) => ({ code })));
  };

  beforeEach(() => {
    repository = { findAccountPermissionCodes: jest.fn() };
    service = new PermissionsService(repository as unknown as RbacRepository);
  });

  it('собирает права аккаунта в множество', async () => {
    grant('Permission.Students.Views', 'Permission.Students.Create');

    const granted = await service.getAccountPermissions(ACCOUNT_ID);

    expect([...granted].sort()).toEqual([
      'Permission.Students.Create',
      'Permission.Students.Views',
    ]);
  });

  it('объединение прав нескольких позиций не дублирует коды (ТЗ 3.2)', async () => {
    // Одно и то же право могут давать две позиции сотрудника.
    grant('Permission.Students.Views', 'Permission.Students.Views');

    const granted = await service.getAccountPermissions(ACCOUNT_ID);

    expect(granted.size).toBe(1);
  });

  it('у аккаунта без позиций прав нет', async () => {
    grant();

    await expect(service.getAccountPermissions(ACCOUNT_ID)).resolves.toEqual(new Set());
  });

  it('отбрасывает код, которого нет в каталоге', async () => {
    // След от прошлой версии приложения: строку в БД синхронизация не удаляет,
    // но доступа она давать не должна — в коде на неё никто не ссылается.
    grant('Permission.Students.Views', 'Permission.Legacy.Whatever');

    const granted = await service.getAccountPermissions(ACCOUNT_ID);

    expect([...granted]).toEqual(['Permission.Students.Views']);
  });

  it('требует все перечисленные права, а не любое из них', async () => {
    grant('Permission.Students.Views');

    await expect(service.hasPermissions(ACCOUNT_ID, ['Permission.Students.Views'])).resolves.toBe(
      true,
    );

    await expect(
      service.hasPermissions(ACCOUNT_ID, [
        'Permission.Students.Views',
        'Permission.Students.Delete',
      ]),
    ).resolves.toBe(false);
  });

  it('пустой список требований не ходит в БД и разрешает', async () => {
    await expect(service.hasPermissions(ACCOUNT_ID, [])).resolves.toBe(true);
    expect(repository.findAccountPermissionCodes).not.toHaveBeenCalled();
  });

  it('спрашивает права ровно того аккаунта, что пришёл из токена', async () => {
    grant();

    await service.hasPermissions(ACCOUNT_ID, ['Permission.Students.Views']);

    expect(repository.findAccountPermissionCodes).toHaveBeenCalledWith(ACCOUNT_ID);
  });
});
