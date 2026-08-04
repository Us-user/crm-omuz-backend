// `jobs.module` намеренно не реэкспортируется — как в остальных модулях:
// barrel затягивают DTO и типы, а модуль тянет контроллеры и репозиторий.
export * from './dto';
export * from './jobs';
export * from './jobs.repository';
export * from './jobs.service';
