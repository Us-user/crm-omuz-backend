import {
  PERMISSION_CATALOG,
  PERMISSION_PREFIX,
  PERMISSION_SECTION_TITLES,
  isPermissionCode,
  permissionCode,
  permissionSectionOf,
} from './permission-catalog';
import { DIRECTOR_ONLY_SECTIONS } from './rbac.constants';

describe('Каталог прав', () => {
  it('не пустой и покрывает разделы ТЗ 5', () => {
    expect(PERMISSION_CATALOG.length).toBeGreaterThan(0);

    const sections = new Set(PERMISSION_CATALOG.map((permission) => permission.section));
    // Разделы, на которые ТЗ ссылается правилами доступа напрямую (3.2, 5.15, 5.16).
    for (const section of ['Accounting', 'Administration', 'Mentors', 'Students'] as const) {
      expect(sections.has(section)).toBe(true);
    }
  });

  it('коды уникальны — иначе синхронизация каталога затирала бы одно право другим', () => {
    const codes = PERMISSION_CATALOG.map((permission) => permission.code);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it('каждый код записан в нотации Permission.<Раздел>.<Действие> (ТЗ 3.2)', () => {
    for (const { code, section, action } of PERMISSION_CATALOG) {
      expect(code).toBe(`${PERMISSION_PREFIX}.${section}.${action}`);
      expect(code).toMatch(/^Permission\.[A-Z][A-Za-z]+\.[A-Z][A-Za-z]+$/);
    }
  });

  it('пример кода из ТЗ существует', () => {
    expect(isPermissionCode('Permission.Mentors.Views')).toBe(true);
  });

  it('у каждого права есть непустое описание: каталог показывается администратору (ТЗ 5.15)', () => {
    for (const { code, description } of PERMISSION_CATALOG) {
      expect(description.trim().length).toBeGreaterThan(0);
      expect(description).not.toBe(code);
    }
  });

  it('у каждого раздела есть человекочитаемое название', () => {
    for (const { section } of PERMISSION_CATALOG) {
      expect(PERMISSION_SECTION_TITLES[section]?.trim()).toBeTruthy();
    }
  });

  it('служебные права — только управление самим каталогом', () => {
    const system = PERMISSION_CATALOG.filter((permission) => permission.isSystem).map(
      (p) => p.code,
    );

    // Выключив их переключателем, вернуть доступ через API было бы уже нечем.
    expect(system).toEqual([
      'Permission.Administration.ViewPermissions',
      'Permission.Administration.ManagePermissions',
    ]);
  });

  it('отвергает код, которого нет в каталоге', () => {
    // Опечатка в декораторе не компилируется, но строка из БД или из запроса —
    // произвольная, и она не должна давать доступ.
    expect(isPermissionCode('Permission.Students.Viwes')).toBe(false);
    expect(isPermissionCode('Permission.Students')).toBe(false);
    expect(isPermissionCode('')).toBe(false);
  });

  it('склеивает код из частей', () => {
    expect(permissionCode('Students', 'Views')).toBe('Permission.Students.Views');
  });

  it('возвращает раздел кода', () => {
    expect(permissionSectionOf('Permission.Accounting.ManageSalary')).toBe('Accounting');
  });

  describe('Правило «Accounting только Director» (ТЗ 3.2, 5.16)', () => {
    it('раздел Accounting закрыт для обычных позиций', () => {
      expect(DIRECTOR_ONLY_SECTIONS).toContain('Accounting');
    });

    it('все права бухгалтерии из ТЗ 5.16 попадают под правило', () => {
      const accounting = PERMISSION_CATALOG.filter(
        (permission) => permission.section === 'Accounting',
      );

      // Правило описано разделом, а не перечислением кодов: любое право,
      // добавленное в Accounting в Фазе 9, автоматически окажется под запретом.
      expect(accounting.length).toBeGreaterThan(1);
      for (const { code } of accounting) {
        expect(DIRECTOR_ONLY_SECTIONS).toContain(permissionSectionOf(code));
      }
    });

    it('остальные разделы правилом не затронуты', () => {
      for (const section of ['Students', 'Groups', 'Administration'] as const) {
        expect(DIRECTOR_ONLY_SECTIONS).not.toContain(section);
      }
    });
  });
});
