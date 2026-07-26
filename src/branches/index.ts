// `branches.module` намеренно не реэкспортируется — как в Auth и Students:
// barrel затягивают DTO и типы других модулей, а модуль тянет контроллер и репозиторий.
export * from './branches.repository';
export * from './branches.service';
export * from './dto';
