// `rbac.module` намеренно не реэкспортируется — по той же причине, что и `auth.module`:
// barrel затягивают декораторы и типы другие модули, а модуль тянет за собой Prisma.
export * from './decorators/require-permission.decorator';
export * from './guards/permissions.guard';
export * from './permission-catalog';
export * from './permissions.service';
export * from './rbac.constants';
export * from './rbac.repository';
