// `rbac.module` и `rbac-admin.module` намеренно не реэкспортируются — по той же
// причине, что и `auth.module`: barrel затягивают декораторы и типы другие модули,
// а модуль тянет за собой Prisma и контроллеры.
export * from './admin-users.repository';
export * from './admin-users.service';
export * from './decorators/require-permission.decorator';
export * from './dto';
export * from './guards/permissions.guard';
export * from './permission-catalog';
export * from './permission-catalog-admin.service';
export * from './permissions.service';
export * from './positions.repository';
export * from './positions.service';
export * from './rbac.constants';
export * from './rbac.repository';
